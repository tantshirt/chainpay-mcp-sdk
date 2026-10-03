// Support watchdog: checks the LIVE /support page and the chain against values
// pinned in this repo's Actions variables, and writes a JSON verdict.
// It never signs or sends anything: the fake wallet only captures what the page
// asks it to sign, then refuses.
//
// Env (all public values): SUPPORT_SITE_URL, SUPPORT_PROGRAM_ID, SUPPORT_VAULT,
// SUPPORT_VAULT_USDC, SUPPORT_RECIPIENT_A, SUPPORT_RECIPIENT_B,
// SUPPORT_RPC_URL (public RPC), SUPPORT_USDC_MINT (default: mainnet USDC).
// Output: verdict JSON on stdout and in $VERDICT_PATH (default ./verdict.json).
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction } from "@solana/web3.js";
import { createHash } from "node:crypto";

const env = process.env;
const need = ["SUPPORT_SITE_URL", "SUPPORT_PROGRAM_ID", "SUPPORT_VAULT", "SUPPORT_VAULT_USDC", "SUPPORT_RECIPIENT_A", "SUPPORT_RECIPIENT_B", "SUPPORT_RPC_URL"];
const missing = need.filter((k) => !env[k]);
if (missing.length) {
  console.error(`missing env: ${missing.join(", ")}`);
  process.exit(2);
}
const PROGRAM = env.SUPPORT_PROGRAM_ID;
const VAULT = env.SUPPORT_VAULT;
const VAULT_USDC = env.SUPPORT_VAULT_USDC;
const USDC_MINT = env.SUPPORT_USDC_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const disc = (name) => [...createHash("sha256").update(`global:${name}`).digest().subarray(0, 8)];

const problems = [];
const fail = (message) => problems.push(message);

// ---------- 1. on-chain: program frozen, recipients unchanged ----------
async function checkChain() {
  const rpc = new Connection(env.SUPPORT_RPC_URL, "confirmed");
  const program = await rpc.getAccountInfo(new PublicKey(PROGRAM));
  if (!program) return fail("program account not found");
  if (program.owner.toBase58() !== UPGRADEABLE_LOADER) return fail(`program owner is ${program.owner.toBase58()}`);
  const programData = new PublicKey(program.data.subarray(4, 36));
  const data = await rpc.getAccountInfo(programData);
  if (!data) return fail("program data account not found");
  // ProgramData: u32 tag, u64 slot, Option<Pubkey> upgrade authority.
  if (data.data[12] !== 0) fail(`program is still upgradeable by ${new PublicKey(data.data.subarray(13, 45)).toBase58()}`);

  const vault = await rpc.getAccountInfo(new PublicKey(VAULT));
  if (!vault) return fail("vault account not found");
  if (vault.owner.toBase58() !== PROGRAM) fail("vault is not owned by the pinned program");
  const a = new PublicKey(vault.data.subarray(8, 40)).toBase58();
  const b = new PublicKey(vault.data.subarray(40, 72)).toBase58();
  if (a !== env.SUPPORT_RECIPIENT_A) fail(`recipient A changed on-chain to ${a}`);
  if (b !== env.SUPPORT_RECIPIENT_B) fail(`recipient B changed on-chain to ${b}`);
}

// ---------- 2. the live page: what it shows and what it asks to sign ----------
const fakeOwner = Keypair.generate().publicKey.toBase58();

// A legacy injected wallet. connect() works; signTransaction() records and refuses.
const injectWallet = `
  (() => {
    const owner = ${JSON.stringify(fakeOwner)};
    const publicKey = { toString: () => owner, toBase58: () => owner };
    window.__captured = [];
    window.solana = {
      isPhantom: true,
      publicKey,
      connect: async () => ({ publicKey }),
      disconnect: async () => {},
      signTransaction: async (tx) => {
        const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
        window.__captured.push(Array.from(bytes));
        throw new Error("watchdog wallet refuses to sign");
      },
    };
  })();
`;

// Answers the page's RPC calls so the balance pre-check passes. Nothing is sent.
function fakeRpc(route) {
  const request = route.request();
  if (request.method() !== "POST") return route.continue();
  let body;
  try {
    body = JSON.parse(request.postData() ?? "{}");
  } catch {
    return route.continue();
  }
  const reply = (result) => ({ jsonrpc: "2.0", id: body.id, result });
  const slot = { context: { slot: 1 } };
  switch (body.method) {
    case "getBalance":
      return route.fulfill({ json: reply({ ...slot, value: 1_000_000_000_000 }) });
    case "getTokenAccountBalance":
      return route.fulfill({ json: reply({ ...slot, value: { amount: "1000000000000", decimals: 6, uiAmount: 1e6, uiAmountString: "1000000" } }) });
    case "getLatestBlockhash":
      return route.fulfill({ json: reply({ ...slot, value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 10 } }) });
    case "sendTransaction":
      fail("page tried to SEND a transaction without a signature");
      return route.fulfill({ json: { jsonrpc: "2.0", id: body.id, error: { code: -1, message: "blocked by watchdog" } } });
    default:
      return route.continue();
  }
}

const MAINNET_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

// "Other token" tips: a v0 transaction where Jupiter swaps into the vault's USDC
// account, then memo + allocate_usdc. Lookup tables are resolved on-chain.
async function assertSwapContribution(bytes) {
  const label = "swap contribution";
  const tx = VersionedTransaction.deserialize(Uint8Array.from(bytes));
  const rpc = new Connection(env.SUPPORT_RPC_URL, "confirmed");
  const tables = (await Promise.all(tx.message.addressTableLookups.map((l) => rpc.getAddressLookupTable(l.accountKey)))).map((r) => r.value).filter(Boolean);
  const keys = tx.message.getAccountKeys({ addressLookupTableAccounts: tables });
  const ixs = tx.message.compiledInstructions.map((ix) => ({
    program: keys.get(ix.programIdIndex).toBase58(),
    accounts: ix.accountKeyIndexes.map((i) => ({ key: keys.get(i).toBase58(), writable: tx.message.isAccountWritable(i) })),
    data: ix.data,
  }));
  const allowed = new Set([ComputeBudgetProgram.programId.toBase58(), ATA_PROGRAM, JUPITER, TOKEN, MEMO, PROGRAM]);
  for (const ix of ixs) if (!allowed.has(ix.program)) fail(`${label}: unexpected program ${ix.program}`);
  const swaps = ixs.filter((ix) => ix.program === JUPITER);
  if (swaps.length !== 1) fail(`${label}: expected exactly one Jupiter swap, got ${swaps.length}`);
  else if (!swaps[0].accounts.some((a) => a.key === VAULT_USDC && a.writable)) fail(`${label}: swap doesn't deliver to the vault's USDC account`);
  const [memo, allocate] = ixs.slice(-2);
  if (memo?.program !== MEMO) fail(`${label}: second-to-last instruction is not the memo`);
  const expected = disc("allocate_usdc");
  if (allocate?.program !== PROGRAM || !expected.every((b, i) => allocate.data[i] === b)) fail(`${label}: last instruction is not allocate_usdc`);
  else if (allocate.accounts[0]?.key !== VAULT) fail(`${label}: allocate targets the wrong vault`);
  for (const ix of ixs.filter((ix) => ix.program === TOKEN)) {
    // Only closing the donor's own temporary account, with lamports back to the donor.
    if (ix.data[0] !== 9 || ix.accounts[1]?.key !== fakeOwner) fail(`${label}: token instruction other than closing the donor's own account`);
  }
  const signers = keys.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).map((k) => k.toBase58());
  if (signers.some((s) => s !== fakeOwner)) fail(`${label}: asks for an unexpected signer`);
}

function assertContribution(bytes, asset) {
  const tx = Transaction.from(Buffer.from(bytes));
  const ixs = tx.instructions;
  const label = `${asset} contribution`;
  if (ixs.length !== 3) return fail(`${label}: expected 3 instructions, got ${ixs.length}`);
  const [transfer, memo, allocate] = ixs;

  if (asset === "SOL") {
    if (!transfer.programId.equals(SystemProgram.programId)) fail(`${label}: first instruction is not a System transfer`);
    if (transfer.data.readUInt32LE(0) !== 2) fail(`${label}: System instruction is not Transfer`);
    if (transfer.keys[1]?.pubkey.toBase58() !== VAULT) fail(`${label}: SOL goes to ${transfer.keys[1]?.pubkey.toBase58()}, not the vault`);
  } else {
    if (transfer.programId.toBase58() !== TOKEN) fail(`${label}: first instruction is not SPL Token`);
    if (transfer.data[0] !== 12) fail(`${label}: token instruction is not TransferChecked`);
    if (transfer.keys[1]?.pubkey.toBase58() !== USDC_MINT) fail(`${label}: wrong mint ${transfer.keys[1]?.pubkey.toBase58()}`);
    if (transfer.keys[2]?.pubkey.toBase58() !== VAULT_USDC) fail(`${label}: USDC goes to ${transfer.keys[2]?.pubkey.toBase58()}, not the vault`);
    if (transfer.keys[3]?.pubkey.toBase58() !== fakeOwner) fail(`${label}: transfer authority is not the donor`);
  }
  if (memo.programId.toBase58() !== MEMO) fail(`${label}: second instruction is not a memo`);
  if (allocate.programId.toBase58() !== PROGRAM) fail(`${label}: third instruction is not the pinned program`);
  const expected = disc(asset === "SOL" ? "allocate_sol" : "allocate_usdc");
  if (!expected.every((byte, i) => allocate.data[i] === byte)) fail(`${label}: third instruction is not allocate`);
  if (allocate.keys[0]?.pubkey.toBase58() !== VAULT) fail(`${label}: allocate targets the wrong vault`);
  // Only the donor may sign; anything else means the page wants extra authority.
  const signers = new Set(ixs.flatMap((ix) => ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())));
  if ([...signers].some((s) => s !== fakeOwner)) fail(`${label}: asks for an unexpected signer`);
}

async function checkPage() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addInitScript(injectWallet);
    await page.route(/solana\.com|helius|rpc/i, fakeRpc);
    await page.goto(new URL("/support", env.SUPPORT_SITE_URL).toString(), { waitUntil: "networkidle" });

    // The page links the vault ("Verify on-chain") and may link recipients; nothing else.
    const links = await page.$$eval("a[href*='/address/']", (as) => as.map((a) => a.getAttribute("href")));
    if (!links.some((href) => href.includes(VAULT))) fail(`page doesn't link the pinned vault ${VAULT}`);
    const unknown = links.filter((href) => ![PROGRAM, VAULT, env.SUPPORT_RECIPIENT_A, env.SUPPORT_RECIPIENT_B].some((p) => href.includes(p)));
    if (unknown.length) fail(`page links unexpected addresses: ${unknown.join(", ")}`);

    // Stepper: amount -> wallet (first time only) -> review -> Send. The fake
    // wallet captures the transaction and refuses, so the card stays on review.
    for (const asset of ["SOL", "USDC"]) {
      if (asset === "USDC") await page.getByRole("button", { name: "Back" }).click();
      await page.getByRole("button", { name: asset, exact: true }).click();
      await page.getByRole("button", { name: "Continue" }).click();
      const phantom = page.getByRole("button", { name: /Phantom, detected/ });
      if (await phantom.isVisible().catch(() => false)) await phantom.click();
      await page.getByRole("button", { name: /^Send / }).click();
      await page.waitForFunction((n) => window.__captured.length >= n, asset === "SOL" ? 1 : 2, { timeout: 20_000 });
    }
    // Any-token tips exist on mainnet only (Jupiter doesn't route on devnet).
    const swapCheck = USDC_MINT === MAINNET_USDC;
    if (swapCheck) {
      await page.getByRole("button", { name: "Back" }).click();
      await page.getByRole("button", { name: "Other", exact: true }).click();
      await page.locator(".token-row", { hasText: "USDT" }).first().click({ timeout: 20_000 });
      await page.locator(".tip-amount input").fill("5");
      await page.locator(".tip-usd", { hasText: "arrives" }).waitFor({ timeout: 20_000 });
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("button", { name: /^Send / }).click();
      await page.waitForFunction(() => window.__captured.length >= 3 || document.querySelector(".tip-error"), null, { timeout: 30_000 });
      // The fake wallet refuses to sign, so an error after a capture is expected.
      const swapCaptured = await page.evaluate(() => window.__captured.length >= 3);
      if (!swapCaptured) fail(`swap flow never reached signing: ${await page.locator(".tip-error").first().innerText().catch(() => "no message")}`);
    }
    const captured = await page.evaluate(() => window.__captured);
    assertContribution(captured[0], "SOL");
    assertContribution(captured[1], "USDC");
    if (swapCheck && captured[2]) await assertSwapContribution(captured[2]);
  } finally {
    await browser.close();
  }
}

const started = new Date().toISOString();
for (const [name, check] of [["chain", checkChain], ["page", checkPage]]) {
  try {
    await check();
  } catch (error) {
    fail(`${name} check crashed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const verdict = { ok: problems.length === 0, checkedAt: started, site: env.SUPPORT_SITE_URL, problems };
writeFileSync(env.VERDICT_PATH ?? "verdict.json", JSON.stringify(verdict, null, 2));
console.log(JSON.stringify(verdict, null, 2));
process.exit(verdict.ok ? 0 : 1);
