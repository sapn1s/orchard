import * as fs from 'node:fs';
const args = process.argv.slice(2); const value = (f) => args[args.indexOf(f) + 1];
const prompt = fs.readFileSync(0, 'utf8');
if (prompt.includes('hang')) await new Promise((r) => setTimeout(r, 60_000));
if (prompt.includes('sleep')) await new Promise((r) => setTimeout(r, 500));
if (prompt.includes('fail')) { process.stderr.write('dispatch failed [internal] fixture failure\n'); process.exit(7); }
const meta = { provider:'openai', sessionId:'fixture-session', exitCode:0, failureKind:null };
fs.writeFileSync(value('--meta-out'), JSON.stringify(meta));
process.stderr.write('fixture progress\n');
process.stdout.write(JSON.stringify({ args, cwd:process.cwd(), prompt }));
