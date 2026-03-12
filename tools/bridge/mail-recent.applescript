-- Mail Recent Script for MARVIN
-- Shows recent unread emails from all accounts (or a specific one)
-- Usage: osascript mail-recent.applescript [days_back] [account_name]

on run argv
    set daysBack to 1
    if (count of argv) > 0 then
        set daysBack to (item 1 of argv) as integer
    end if

    set accountFilter to ""
    if (count of argv) > 1 then
        set accountFilter to item 2 of argv
    end if

    set cutoffDate to (current date) - (daysBack * days)
    set resultList to {}
    set maxResults to 20
    set foundCount to 0

    tell application "Mail"
        if accountFilter is "" then
            set targetAccounts to every account
        else
            set targetAccounts to {account accountFilter}
        end if

        repeat with acct in targetAccounts
            if foundCount ≥ maxResults then exit repeat
            set acctName to name of acct

            try
                set inboxMb to mailbox "Inbox" of acct
                set recentMsgs to (every message of inboxMb whose date received ≥ cutoffDate and read status is false)

                repeat with msg in recentMsgs
                    if foundCount ≥ maxResults then exit repeat

                    set msgSubject to subject of msg
                    set msgSender to sender of msg
                    set msgDate to date received of msg
                    set msgId to id of msg

                    set dateStr to (month of msgDate as integer) & "/" & (day of msgDate) & " " & (hours of msgDate) & ":" & (minutes of msgDate)

                    set msgInfo to "---" & return
                    set msgInfo to msgInfo & "ID: " & msgId & return
                    set msgInfo to msgInfo & "Account: " & acctName & return
                    set msgInfo to msgInfo & "Date: " & dateStr & return
                    set msgInfo to msgInfo & "From: " & msgSender & return
                    set msgInfo to msgInfo & "Subject: " & msgSubject & return

                    set end of resultList to msgInfo
                    set foundCount to foundCount + 1
                end repeat
            end try
        end repeat
    end tell

    if foundCount = 0 then
        return "No unread messages in the last " & daysBack & " day(s)."
    else
        set output to "Found " & foundCount & " unread messages:" & return & return
        repeat with r in resultList
            set output to output & r
        end repeat
        return output
    end if
end run
