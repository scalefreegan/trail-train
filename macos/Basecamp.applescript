-- Basecamp launcher: a stay-open Dock app wrapping the trail-train dev server.
--
-- Why this shape: the dashboard is not a static site — its coach chat, resync
-- and settings endpoints are Vite dev-server middleware that spawn node
-- scripts and the `claude` CLI, so "the app" IS the dev server plus a browser
-- tab. This applet gives that server real app semantics: launch by icon, a
-- Dock presence while it runs, reopen-to-focus, and Quit stops the server.
--
-- Why a helper app runs the actual server (two hard-won macOS facts):
--   1. TCC attribution does not survive orphaning — a nohup/disown'd server
--      is reparented to launchd, loses its launcher's Documents grant, and
--      dies with a silent EPERM (the repo lives under ~/Documents).
--   2. Only Cocoa processes are offered TCC permission dialogs — a plain
--      shell-script bundle is silently denied, no prompt ever.
-- So the server runs as the BLOCKING child of "Basecamp Server.app", a
-- faceless Cocoa applet that can actually receive the one-time Documents
-- prompt and stays alive exactly as long as the server does. This applet is
-- the Dock face: Quit pkills vite, which unwinds npm → helper.
--
-- The server runs on the FIXED port below (strictPort in vite.config.ts), so
-- health checks and the dashboard URL are deterministic.
-- Built and installed by macos/build-app.sh (osacompile -s for stay-open).

property dashUrl : "http://localhost:38100"
-- absolute, not a bare "trail-train/..." substring: pkill -f matches the
-- whole command line, so an unanchored pattern would also catch a second
-- clone of this repo elsewhere, or an editor whose argv held the path. The
-- vite process argv carries this absolute path. (It still, by design, stops a
-- server for THIS repo you started by hand — one repo, one server.)
property killPattern : "/Users/brooks/Documents/git/trail-train/web/node_modules/.bin/vite"
property wasUp : false

on serverUp()
	-- Match a string only the dashboard serves, not a bare 200. strictPort
	-- means a foreign process already on 38100 makes OUR vite fail to start,
	-- and a bare status check would then treat the impostor as "up" and open
	-- the browser to it. The whole reason 38100 was chosen was to make a
	-- collision detectable — so detect it. The app's <title> is the marker
	-- (tt-yib.5: it used to be the race name, which changes per race).
	try
		set body to do shell script "curl -s --max-time 2 " & dashUrl
		return body contains "Basecamp"
	on error
		return false
	end try
end serverUp

on startServer()
	-- -g: launch in the background, never stealing focus. The helper nests
	-- inside THIS bundle (Contents/Helpers/), so resolve it from path to me —
	-- one visible app in /Applications, and the pair can never split up.
	set helperPath to POSIX path of (path to me) & "Contents/Helpers/Basecamp Server.app"
	do shell script "open -g " & quoted form of helperPath
	-- cold node_modules can take a while; poll rather than hope
	repeat 60 times
		if serverUp() then exit repeat
		delay 0.5
	end repeat
end startServer

on openDashboard()
	-- Prefer focusing a tab already on this app over opening a new one: plain
	-- `open` hands off to the default browser (Chrome), which always makes a
	-- fresh tab, scattering sessions every time the Dock icon is clicked.
	-- Match by URL PREFIX, not equality, so a tab mid-navigation still counts
	-- as "this app's tab" and is refocused instead of duplicated. First use
	-- prompts for Automation access to Chrome (System Settings > Privacy &
	-- Security > Automation).
	-- handled: true once Chrome has focused or opened a tab, so an error
	-- after that point never falls back into a second, duplicate tab
	set handled to false
	try
		tell application "Google Chrome"
			-- activate FIRST: raising a window while Chrome is in the background
			-- can leave the previous window key; and if Chrome was not running,
			-- this restores its session, so a restored tab is found, not duplicated
			activate
			-- remember the window by id, not index: Chrome numbers windows front
			-- to back, so un-minimizing one renumbers the rest
			set targetWinId to missing value
			set targetTabIndex to 0
			repeat with w in (every window)
				set tabCount to count of tabs of w
				repeat with ti from 1 to tabCount
					if (URL of tab ti of w) starts with dashUrl then
						set targetWinId to id of w
						set targetTabIndex to ti
						exit repeat
					end if
				end repeat
				if targetWinId is not missing value then exit repeat
			end repeat
			if targetWinId is not missing value then
				set targetWin to window id targetWinId
				set active tab index of targetWin to targetTabIndex
				set handled to true
				try
					set minimized of targetWin to false
				end try
				set index of targetWin to 1
			else
				-- a new tab goes in a normal, visible window: an incognito one
				-- would not have the app's login, a minimized one shows nothing
				set hostWinId to missing value
				repeat with w in (every window)
					if (mode of w is "normal") and (minimized of w is false) then
						set hostWinId to id of w
						exit repeat
					end if
				end repeat
				if hostWinId is missing value then
					make new window
					set URL of active tab of window 1 to dashUrl
					set handled to true
				else
					tell window id hostWinId to make new tab with properties {URL:dashUrl}
					set handled to true
					set index of window id hostWinId to 1
				end if
			end if
		end tell
	on error errMsg number errNum
		-- log why, since from the outside a refusal looks exactly like "it
		-- still opens a new tab"
		try
			do shell script "echo " & quoted form of ("[launcher] Chrome tab focus failed (" & errNum & "): " & errMsg) & " >> ~/Library/Logs/Basecamp.log"
		end try
		if errNum is -1743 then
			display notification "Allow Basecamp to control Google Chrome (System Settings > Privacy & Security > Automation) so a click returns to its open tab." with title "Basecamp"
		end if
	end try
	-- Chrome unreachable or Automation refused: the old behavior, never nothing
	if not handled then do shell script "open " & quoted form of dashUrl
end openDashboard

on run
	if not serverUp() then
		startServer()
		if serverUp() then
			set wasUp to true
			display notification "Server running at " & dashUrl with title "Basecamp"
		else
			display notification "Server failed to start — see ~/Library/Logs/Basecamp.log (a Documents permission prompt may be waiting)" with title "Basecamp"
			quit
		end if
	else
		set wasUp to true
	end if
	openDashboard()
end run

-- double-clicking the icon while already running lands here: focus, don't fork
on reopen
	if not serverUp() then startServer()
	openDashboard()
end reopen

-- keep the Dock state truthful: if the server dies out from under us, the
-- icon should not keep claiming it is running. wasUp gates it so a failed
-- FIRST start does not self-destruct mid-diagnosis.
on idle
	if serverUp() then
		set wasUp to true
	else if wasUp then
		quit
	end if
	return 15
end idle

on quit
	try
		do shell script "pkill -f " & quoted form of killPattern
	end try
	continue quit
end quit
