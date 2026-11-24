use framework "Foundation"
use scripting additions

on run
    set argv to (current application's NSProcessInfo's processInfo()'s arguments()) as list
    -- Clicking an old notification launches us without a payload. Do not repost it.
    if (count of argv) < 4 then return
    if item -3 of argv is not "--klide-notification" then return
    display notification (item -1 of argv as text) with title (item -2 of argv as text)
end run
