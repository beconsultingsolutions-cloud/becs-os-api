# Next steps

Three jobs were left for you after the October 2026 revamp. Each has a prompt you can paste into Claude Code, opened in this folder. Do them in this order.

## 1. Make your first app key (2 minutes)

No prompt needed.

1. Open https://becs-os-api.be-consulting-solutions.workers.dev and paste your master key into the key box.
2. Go to **Keys**, choose **New key**.
3. Name it for what will use it (for example `claude-loader`) and tick only what it needs.
4. Copy the key when it appears and save it in your password manager. It is shown once.

## 2. Move your Notion clients and tasks in (20 to 40 minutes)

You need: Notion connected to Claude (run `/mcp` in Claude Code and connect Notion with your own account), and an app key from step 1 with read and write on clients, projects and tasks.

Before starting Claude Code, put the key in an environment variable so it never appears in the chat. In PowerShell:

```powershell
$s = Read-Host "Paste the app key (typing is hidden)" -AsSecureString
$env:BECS_APP_KEY = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
claude
```

Then paste this:

```text
I want to move my clients and tasks from Notion into BECS OS. Read docs/SPEC.md first for the fields and allowed values.

The API is https://becs-os-api.be-consulting-solutions.workers.dev/api and my app key is in the environment variable BECS_APP_KEY. Never print or echo the key.

1. Search my Notion workspace for the databases or pages where I track clients, projects and tasks. Show me what you found and ask me which ones to use. Do not guess.
2. GET /api/ventures, /api/clients, /api/projects and /api/tasks so you know what is already in BECS OS.
3. Build a proposed import as a table for me to review: for each Notion row, the venture, the BECS OS fields it maps to, and anything that does not fit (a status with no match, a missing venture, a likely duplicate of something already there). Ask me about each thing that does not fit.
4. Wait for my OK. Then create clients first, then projects, then tasks, through the API, one at a time, so links between them use the new ids. Put "Imported from Notion" plus the Notion page link in each record's notes.
5. If any request fails, stop and show me the error message. Do not retry blindly.
6. At the end, show me counts created per table and GET /api/dashboard.

Do not change or delete anything in Notion.
```

Everything it creates shows in the console's activity feed under the app key's name, so you can see exactly what was added.

## 3. Turn on email sign-in (10 minutes)

Until this is done you sign in to the console by pasting a key. The steps are in `README.md` under "Turning on Cloudflare Access". They need clicks in your Cloudflare dashboard, so Claude cannot do them for you, but it can walk you through. Paste this:

```text
Walk me through README.md "Turning on Cloudflare Access" one step at a time. Wait for me to confirm each step before the next.

Things I need you to get right:
- There must be TWO Access applications: one for the whole site with an Allow policy for my email only, and a separate one for the /api path with a Bypass policy. Check with me that I made two, because one application over everything is what broke the site last time.
- When I give you the team domain, the AUD tag and my email, put them in the three vars in wrangler.jsonc, show me the change, run npm test, and ask before you deploy.
- After deploying, have me open the site in a private browser window and tell you what I see. Then run node scripts/live-check.mjs to confirm app keys still work.
- If sign-in does not work, set the three vars back to empty strings and deploy again so I am back to the key box, then help me work out what went wrong.
```

The email sign-in has passed every test we could run without real Cloudflare Access, but your first real sign-in is the first true test of it. The last bullet above is your way back if it misbehaves.

## Loose files you can delete

These are in your Downloads folder and describe an older design that no longer matches the server. Nothing uses them.

- `HANDOFF.md`
- `index (5).html`, `index (6).html`
- `becs-os-api.zip`
