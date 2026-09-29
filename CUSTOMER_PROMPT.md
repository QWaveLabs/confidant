# Send this to the customer

Send the customer this exact message. `scripts/release.mjs` fills in the
placeholders for you and writes the result to `dist/customer-prompt.txt`.

> I want to set up my Confidant second brain. Please clone {REPO_URL} at tag
> {TAG} into a safe local folder, and check that its latest commit is exactly
> {SHA}. If it isn't, stop and tell me instead of continuing. Then open the
> folder and follow its AGENTS.md instructions.
>
> Do all the technical work yourself. Don't ask me to open Terminal or run
> commands. Ask me only one question at a time, and only when you need my
> choice: a sign-in, a permission, or something about how I work. Keep every
> source read-only, and never send, post or reply to anything on my
> behalf. Before you finish, tell me plainly what's connected, what's
> still filling in, and what's skipped or blocked.
>
> My blueprint: role=founder, brief=06:45, language=en, never=banking, health

The last line is optional. It's a shortcut so Codex can prefill the first
setup question instead of asking from scratch. Edit it, or leave it out
entirely: role is one of founder, agency, consultant, investor, sales,
executive or recruiter; brief is the time of day for the morning brief,
HH:MM; language is en or es; never is a plain list of anything that should
always stay out (banking, health, a family chat's name, a client under NDA).
