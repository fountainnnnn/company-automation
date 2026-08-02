# Credentials (local only — do NOT commit to any public repo)

## Dashboard logins (Supabase Auth)
| Role | Email | Password |
|---|---|---|
| Admin | `admin@clautomation.local` | `vos2h1O2dVAIpHcK` |
| Staff | `staff@clautomation.local` | `Ws1ynCqLtuFo9esT` |

Change these after first login (or ask Claude to rotate them).

## Supabase
- Project: `automation` (`odsofzzjniafttbdhtye`) — https://odsofzzjniafttbdhtye.supabase.co
- Publishable key (safe for the SPA): `sb_publishable_SSXeRx2cQrhSH9QX3JrLbg_pkVvu_rC`

## Telegram
- Bot: @CLAutomationBot
- Bot token + webhook secret: stored in `public.app_secrets` table (RLS: service-role only).
  Rotate via @BotFather `/revoke`, then update the `telegram_bot_token` row.
