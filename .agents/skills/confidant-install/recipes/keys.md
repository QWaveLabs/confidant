# Getting API keys

Confidant needs a short visit to each service's own settings page to get an
API key. Do this once per service, only for the services the person
actually uses. Never ask the person to paste a key into the chat: run
`confidant keys set <name>` instead. That command opens a small, hidden
macOS dialog right on the person's screen. What they type there goes
straight into this Mac's Keychain and is never shown in the chat or printed
anywhere.

Check what is already saved first: `confidant keys status`. It only prints
which keys exist, never their values.

For each service the person wants to connect:

## Deepgram (`deepgram`)

Used to transcribe phone call recordings and Voice Memos. The person signs
up at https://console.deepgram.com, creates a project if asked, and opens
API Keys in the left sidebar. They create a new key and copy it.

Run `confidant keys set deepgram`.

## Fathom (`fathom`)

The person signs in to https://fathom.video, opens Settings, then
Integrations, then API, and generates a key there.

Run `confidant keys set fathom`.

## Fireflies (`fireflies`)

The person signs in to https://app.fireflies.ai, opens their profile menu,
then Integrations, then API Key, and copies their API key. The free plan
allows only 50 API requests a day, so Confidant paces itself and finishes
importing over several runs. This is expected, not a failure; say so if the
person asks why Fireflies is taking a few days to catch up.

Run `confidant keys set fireflies`.

## Granola (`granola`)

Granola's API is only on the Business plan and up. If the person is on a
lower plan, skip this and say so plainly; do not ask them to upgrade. On
Business or higher, they sign in at https://granola.ai, open Settings, then
Integrations, then API, and create a key (it starts with `grn_`).

Run `confidant keys set granola`.

## Grain (`grain`)

The person signs in to https://grain.com, opens Settings, then
Integrations, then the API tab, and creates a Personal Access Token.

Run `confidant keys set grain`.

## tl;dv (`tldv`)

The person signs in to https://tldv.io, opens Settings, then Personal
Settings, then API Keys, and generates a new key. Programmatic access
depends on the meeting organizer's plan (Pro, Business or Enterprise); if
their account is Free, tell them tl;dv import will be skipped even though
they can still see their meetings in the tl;dv app.

Run `confidant keys set tldv`.

## Read.ai (`readai`)

Read.ai does not have a simple "copy one key" page. Getting a credential is
a short, one-time technical setup, best done by you (Codex) from a
terminal, with the person only doing the sign-in step in their browser:

1. Register a client:
   `curl -X POST https://api.read.ai/oauth/register -H "Content-Type: application/json" -d '{"client_name": "Confidant", "redirect_uris": ["https://api.read.ai/oauth/ui"], "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"], "scope": "openid email offline_access profile meeting:read mcp:execute", "token_endpoint_auth_method": "client_secret_basic"}'`
   Keep the `client_id` and `client_secret` from the response; they are
   needed in step 4.
2. Ask the person to open https://api.read.ai/oauth/ui, enter that client
   ID and secret, start the flow, sign in to Read.ai, and click Allow
   Access.
3. Ask them to copy the command the page shows at the end and paste it back
   to you, or to run it themselves in a terminal if they are comfortable.
   That exchanges the authorization code for an `access_token` and a
   `refresh_token`. Only the refresh token is kept.
4. Run `confidant keys set readai` and, when the hidden dialog appears,
   have the person (or you, if they shared the values with you) paste the
   three values joined by colons, in this order:
   `client_id:client_secret:refresh_token`

This is more setup than the other services, and it is fair to skip it if
the person does not want to go through it. If they decline, say so plainly
and move on; nothing else in Confidant depends on Read.ai.
