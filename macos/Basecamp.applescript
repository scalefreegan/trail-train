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
-- A fresh launch restarts the server (stopExistingServer), so opening the
-- app always runs the checkout's current code.
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
-- ($| --) anchors the end: still matches a vite launched with arguments
-- (--host), while excluding `vite build` / `vite preview` (their first arg is
-- a subcommand), and the pattern no longer matches its own text in the
-- `sh -c "pgrep -f ..."` line that stopExistingServer's check runs.
property killPattern : "/Users/brooks/Documents/git/trail-train/web/node_modules/.bin/vite($| --)"
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

-- A test or automation Chrome (the Playwright MCP's, with its profile under
-- ~/Library/Caches/ms-playwright*, or anything started with a remote-debugging
-- flag) is also "Google Chrome" to AppleScript, and a tell can land in it: a
-- tab there has no real microphone or speakers. While one is running, Chrome
-- isn't scripted at all.
on testChromeRunning()
	try
		do shell script "pgrep -f " & quoted form of "Google Chrome.*(ms-playwright|--remote-debugging-p(ipe|ort))"
		return true
	on error
		return false
	end try
end testChromeRunning

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
	if testChromeRunning() then
		-- Hand the URL to the user's own Chrome: a new instance on the default
		-- profile passes it to the running one (Chrome's per-profile
		-- singleton) and exits, or becomes the user's Chrome if none is up.
		-- Always a new tab, but never one in the test browser.
		do shell script "open -n -a 'Google Chrome' --args " & quoted form of dashUrl
		return
	end if
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

-- A fresh launch (the icon clicked while the Dock app isn't running) means
-- "give me the app as it is now", so a server already on the port from
-- this checkout is stopped first and a new one started: otherwise a
-- server left running for days (a manual `npm run dev`, or one that outlived
-- its Dock icon) keeps serving whatever it loaded, and quitting and
-- reopening the app changes nothing. Only a server matching killPattern
-- (this checkout's vite) is stopped: a worktree's server, or a stranger on
-- the port, is never touched. A click while the app is running (reopen)
-- still just focuses the tab.
on stopExistingServer()
	try
		do shell script "pgrep -f " & quoted form of killPattern
	on error
		return -- none of ours running
	end try
	try
		do shell script "echo " & quoted form of ("[launcher] fresh launch: stopping the running server " & (current date)) & " >> ~/Library/Logs/Basecamp.log"
	end try
	try
		do shell script "pkill -f " & quoted form of killPattern
	end try
	-- wait for it to let go of the port (TERM first, KILL after 10 s)
	repeat with i from 1 to 30
		if not portBound() then return
		if i = 20 then
			try
				do shell script "pkill -9 -f " & quoted form of killPattern
			end try
		end if
		delay 0.5
	end repeat
end stopExistingServer

on portBound()
	try
		do shell script "lsof -nP -iTCP:38100 -sTCP:LISTEN -t"
		return true
	on error
		return false
	end try
end portBound

on run
	stopExistingServer()
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
