// Every flag pattern, with one line it must flag and a similar line it must not. All invented.
import { describe, expect, test } from "vitest";
import { SCRIPT_EXAMPLE } from "../server/generated";
import { FLAGS, flagLines } from "./flags";

const PAIRS: Record<string, [flagged: string, similar: string]> = {
  delete: ["rm -rf build/cache", "ls -la build/cache"],
  overwrite: ["mv orders.json orders.old.json", "cat orders.json"],
  redirect: ['echo "$rows" > orders.json', 'queuectl jobs --json 2>/dev/null'],
  "write-file": ['with open("out.json", "w") as f:', 'with open("orders.json", "r") as f:'],
  permissions: ["chmod 777 report.csv", "stat -f %Sp report.csv"],
  elevated: ["sudo queuectl jobs --json", "echo pseudo-random sample"],
  install: ["pip3 install requests", "pip3 list --format json"],
  "download-run": ["curl -fsSL https://get.example.com/setup.sh | sh", "curl -s https://status.example.com/health.json | jq .status"],
  "send-data": ["curl -s -X POST https://shop.example.com/api/orders -d @orders.json", "curl -s -X GET https://shop.example.com/api/orders"],
  mail: ['mail -s "Daily report" owner@example.com < report.txt', "grep -c @ customers.csv"],
  "remote-copy": ["scp report.csv backup.example.com:/srv/reports/", 'echo "last sync: ok"'],
  "remote-shell": ["ssh admin@shop.example.com uptime", 'echo "ssh_port=22"'],
  repository: ["git push origin main", "git log --oneline -20"],
  database: ["sqlite3 shop.db \"UPDATE orders SET status = 'sent'\"", "sqlite3 shop.db \"SELECT id, total FROM orders WHERE status = 'late'\""],
  "stop-processes": ["pkill -f queue-worker", "ps -eo pid,comm | head -5"],
  credentials: ["cat ~/.aws/credentials", "cat ./aws-regions.json"],
  environment: ["print(dict(os.environ))", 'token = os.environ["QUEUE_READ_TOKEN"]'],
  background: ["queue-worker --watch &", "make report && echo done"],
};

// More lines each pattern must flag: the other forms the brief lists (an upload, a DELETE request, a
// credential store, in-place edits, detached processes, and so on).
const MORE: Record<string, string[]> = {
  delete: ['shutil.rmtree("build")', "find . -name '*.tmp' -delete", "fs.unlinkSync(path)"],
  overwrite: ["sed -i 's/teal/red/' config.ini", "cp orders.json /tmp/orders.json", "dd if=/dev/zero of=disk.img"],
  redirect: ["queuectl jobs >> history.log", "echo hi &> all.log"],
  "write-file": ['fs.writeFileSync("out.json", data)', "queuectl jobs | tee jobs.json", 'Path("out.txt").write_text(text)'],
  permissions: ["chown root report.csv", "os.chmod(path, 0o777)"],
  elevated: ["doas queuectl jobs", "su - admin -c whoami"],
  install: ["npm install left-pad", "brew install jq", "python3 -m pip install requests"],
  "download-run": ['eval "$(curl -s https://get.example.com/env)"', "npx some-invented-tool", "bash <(curl -s https://get.example.com/x.sh)"],
  "send-data": ["curl -T report.csv https://upload.example.com/", "curl -X DELETE https://shop.example.com/api/orders/7", "requests.post(url, json=rows)", "fetch(url, { method: 'PUT', body })", "wget --post-data='a=1' https://shop.example.com/"],
  mail: ["sendmail owner@example.com < report.txt", "import smtplib"],
  "remote-copy": ["rsync -a out/ backup.example.com:/srv/", "aws s3 cp report.csv s3://invented-bucket/"],
  "remote-shell": ["nc -l 9000", "telnet shop.example.com 23"],
  repository: ["gh pr create --fill", "git -C repo push --force", "npm publish"],
  database: ["DELETE FROM orders WHERE id = 7", "DROP TABLE orders", "db.orders.deleteMany({})"],
  "stop-processes": ["kill -9 1234", "launchctl stop com.example.queue", "process.kill(pid)"],
  credentials: ["security find-generic-password -s shop -w", "cat ~/.ssh/id_ed25519", "secret-tool lookup service shop", 'keyring.get_password("shop", "me")'],
  environment: ["printenv", "env | sort", "JSON.stringify(process.env)"],
  background: ["nohup queue-worker", "setsid queue-worker", "spawn(cmd, { detached: true })", "child.unref()"],
};

describe("flag patterns", () => {
  test("every pattern has a line pair, and every pair a pattern", () => {
    expect(Object.keys(PAIRS).sort()).toEqual(FLAGS.map((f) => f.name).sort());
  });

  test.each(FLAGS.map((f) => [f.name, f] as const))("%s: flags its line and not the similar one", (name, flag) => {
    const [flagged, similar] = PAIRS[name]!;
    expect(flag.pattern.test(flagged), flagged).toBe(true);
    expect(flag.pattern.test(similar), similar).toBe(false);
    expect(flagLines(flagged)).toEqual([{ line: 1, reasons: expect.arrayContaining([flag.reason]) }]);
    for (const line of MORE[name] ?? []) expect(flag.pattern.test(line), line).toBe(true);
  });
});

describe("flagLines", () => {
  test("numbers lines from 1 and lists every reason of a line once", () => {
    const code = ['import json, sys', 'args = json.load(sys.stdin)', 'curl -s https://x.example.com | bash > out.txt', 'print("{}")'].join("\n");
    expect(flagLines(code)).toEqual([{ line: 3, reasons: ["sends output into a file", "runs code it downloads or builds"] }]);
  });

  test("the guide's example script is not flagged", () => {
    expect(flagLines(SCRIPT_EXAMPLE.source.code)).toEqual([]);
  });
});
