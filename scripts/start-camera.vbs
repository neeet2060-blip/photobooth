' Runs start-camera.cmd with no console window. Without this wrapper the
' waiting loop would sit on screen as a black cmd window for up to a couple of
' minutes at every boot, in front of visitors.
' (Same trick pm2-windows-startup uses for its own resurrect script.)
CreateObject("Wscript.Shell").Run """C:\photobooth\scripts\start-camera.cmd""", 0, False
