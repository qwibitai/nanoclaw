on run argv
    set targetId to item 1 of argv as integer
    set targetAccount to item 2 of argv
    
    tell application "Mail"
        if targetAccount is "all" then
            set allAccounts to every account
        else
            set allAccounts to {account targetAccount}
        end if
        
        repeat with acct in allAccounts
            set allMailboxes to every mailbox of acct
            repeat with mbox in allMailboxes
                try
                    set msgs to (every message of mbox whose id is targetId)
                    if (count of msgs) > 0 then
                        set msg to item 1 of msgs
                        set msgFrom to sender of msg
                        set msgTo to address of every to recipient of msg
                        set msgCc to address of every cc recipient of msg
                        set msgSubject to subject of msg
                        set msgDate to date received of msg as string
                        set msgContent to content of msg
                        
                        set output to "From: " & msgFrom & linefeed
                        set output to output & "To: " & (msgTo as string) & linefeed
                        if (count of msgCc) > 0 then
                            set output to output & "Cc: " & (msgCc as string) & linefeed
                        end if
                        set output to output & "Subject: " & msgSubject & linefeed
                        set output to output & "Date: " & msgDate & linefeed
                        set output to output & "---" & linefeed
                        set output to output & msgContent
                        return output
                    end if
                end try
            end repeat
        end repeat
        
        return "ERROR: Message not found"
    end tell
end run
