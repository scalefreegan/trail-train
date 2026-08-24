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
property killPattern : "trail-train/web/node_modules/.bin/vite"
property wasUp : false

on serverUp()
	try
		do shell script "curl -s --max-time 2 -o /dev/null -w '%{http_code}' " & dashUrl
		return result is "200"
	on error
		return false
	end try
end serverUp

on startServer()
	-- -g: launch in the background, never stealing focus. The helper nests
	-- inside THIS bundle (Contents/Helpers/), so resolve it from path to me —
	-- one visible app in ~/Applications, and the pair can never split up.
	set helperPath to POSIX path of (path to me) & "Contents/Helpers/Basecamp Server.app"
	do shell script "open -g " & quoted form of helperPath
	-- cold node_modules can take a while; poll rather than hope
	repeat 60 times
		if serverUp() then exit repeat
		delay 0.5
	end repeat
end startServer

on openDashboard()
	do shell script "open " & quoted form of dashUrl
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
