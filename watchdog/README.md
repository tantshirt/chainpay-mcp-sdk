# Support watchdog (fork only)

It checks, every 15 minutes, that:

- the live `/support` page links only the pinned program, vault and recipient addresses;
- the transaction the page asks a wallet to sign is exactly `transfer → pinned vault`, `memo`, `allocate(pinned program)`, with no extra signer. It uses a fake wallet that captures the transaction and refuses to sign;
- on-chain, the program's upgrade authority is still none and the vault's recipients haven't changed.

When a check fails, it sends Telegram and email to both maintainers. When the checks pass, it pings a healthcheck, so silence also raises an alert.

**What it can't do:** it can't stop a swap, and it can't get back money already sent. A deployer can also show a different page to bots than to people. Treat it as a detector.

## Turn it on

1. Merge this branch into the fork's `master`. GitHub only runs scheduled workflows from the default branch.
2. In the fork, go to Settings → Secrets and variables → Actions:
   - Add the repo **variables** listed at the top of `.github/workflows/support-watchdog.yml`. All of them are public values from DEPLOY.md gates 3–4.
   - Add the **secrets** listed there. Never paste these anywhere else.
3. Create a check at healthchecks.io with a 30-minute period, and put its ping URL in `HEALTHCHECK_PING_URL`.
4. Run it once by hand: Actions → support-watchdog → Run workflow.

## Run locally

```
cd watchdog && npm install && npx playwright install chromium
SUPPORT_SITE_URL=… SUPPORT_PROGRAM_ID=… SUPPORT_VAULT=… SUPPORT_VAULT_USDC=… \
SUPPORT_RECIPIENT_A=… SUPPORT_RECIPIENT_B=… SUPPORT_RPC_URL=https://api.mainnet-beta.solana.com \
node support-watchdog.mjs
```
