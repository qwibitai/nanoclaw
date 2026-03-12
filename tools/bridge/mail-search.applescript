-- Mail Search Script for MARVIN
-- Usage: osascript mail-search.applescript "search_term" [days_back] [account_filter]

on run argv
    set searchTerm to item 1 of argv

    -- Default: 7 days back
    set daysBack to 7
    if (count of argv) > 1 then
        set daysBack to (item 2 of argv) as integer
    end if

    -- Default: Exchange account (Penn Medicine)
    set accountFilter to "Exchange"
    if (count of argv) > 2 then
        set accountFilter to item 3 of argv
    end if

    set cutoffDate to (current date) - (daysBack * days)
    set resultList to {}
    set maxResults to 25
    set foundCount to 0

    tell application "Mail"
        -- Get target account
        if accountFilter is "all" then
            set targetAccounts to every account
        else
            set targetAccounts to {account accountFilter}
        end if

        repeat with acct in targetAccounts
            if foundCount ≥ maxResults then exit repeat

            set acctName to name of acct
            set allMailboxes to every mailbox of acct

            repeat with mb in allMailboxes
                if foundCount ≥ maxResults then exit repeat

                try
                    set mbName to name of mb

                    -- Search messages in this mailbox
                    set matchingMsgs to (every message of mb whose (subject contains searchTerm or sender contains searchTerm) and date received ≥ cutoffDate)

                    repeat with msg in matchingMsgs
                        if foundCount ≥ maxResults then exit repeat

                        set msgSubject to subject of msg
                        set msgSender to sender of msg
                        set msgDate to date received of msg
                        set msgId to id of msg

                        -- Format date nicely
                        set dateStr to (month of msgDate as integer) & "/" & (day of msgDate) & " " & (hours of msgDate) & ":" & (minutes of msgDate)

                        set msgInfo to "---" & return
                        set msgInfo to msgInfo & "ID: " & msgId & return
                        set msgInfo to msgInfo & "Account: " & acctName & return
                        set msgInfo to msgInfo & "Folder: " & mbName & return
                        set msgInfo to msgInfo & "Date: " & dateStr & return
                        set msgInfo to msgInfo & "From: " & msgSender & return
                        set msgInfo to msgInfo & "Subject: " & msgSubject & return

                        set end of resultList to msgInfo
                        set foundCount to foundCount + 1
                    end repeat
                end try
            end repeat
        end repeat
    end tell

    if foundCount = 0 then
        return "No messages found matching '" & searchTerm & "' in the last " & daysBack & " days."
    else
        set output to "Found " & foundCount & " messages:" & return & return
        repeat with r in resultList
            set output to output & r
        end repeat
        return output
    end if
end run
