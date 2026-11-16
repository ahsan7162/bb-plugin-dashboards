// The approval dialog's flagged lines (PLAN section 7): what a read-only script should never need, one
// pattern and one short reason each. A help for the reader, not a guard: a harmful line can match none
// of these, and a harmless one can match. Each pattern is tested on one line, with a line that matches
// and a similar one that does not (ui/flags.test.ts).
export type Flag = { name: string; pattern: RegExp; reason: string };

export const FLAGS: readonly Flag[] = [
  {
    name: "delete",
    pattern: /\b(rm|rmdir|unlink|shred|srm)\s|\bfind\b.*\s-delete\b|\b(shutil\.rmtree|os\.(remove|unlink|rmdir)|fs\.(rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync))\b/,
    reason: "deletes files",
  },
  { name: "overwrite", pattern: /\b(mv|cp|dd|truncate)\s|\bsed\s+(-[a-zA-Z]*i|--in-place)|\bln\s+-[a-zA-Z]*f/, reason: "moves, copies or overwrites files" },
  { name: "redirect", pattern: /(^|[\s;|&(])(\d|&)?>>?(?!>|=|&|\s*\/dev\/(null|stdout|stderr)\b)\s*\S/, reason: "sends output into a file" },
  { name: "write-file", pattern: /\bopen\([^)]*,\s*(mode\s*=\s*)?["'][rwax]*[wax+]|\.(write_text|write_bytes)\(|\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream)\b|\btee\b/, reason: "writes a file" },
  { name: "permissions", pattern: /\b(chmod|chown|chgrp|chflags|chattr|setfacl|icacls|takeown)\b|\b(os|fs)\.(chmod|chown)/, reason: "changes permissions or owners" },
  { name: "elevated", pattern: /\b(sudo|doas|pkexec|runas)\b|\bsu\s+(-|\w)|with administrator privileges/, reason: "asks for elevated rights" },
  {
    name: "install",
    pattern: /\b(pip3?|pipx|uv|npm|pnpm|yarn|bun|brew|apt|apt-get|yum|dnf|apk|gem|cargo|go|conda|port|choco|winget)\s+(install|add|i|get|upgrade)\b|\bpython3?\s+-m\s+pip\s+install\b/,
    reason: "installs packages",
  },
  {
    name: "download-run",
    pattern: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|dash|python3?|node|perl|ruby)\b|<\(\s*(curl|wget)\b|\b(npx|bunx|uvx)\b|\bpipx\s+run\b|\beval\b|\bexec\s*\(|\bnew\s+Function\s*\(/,
    reason: "runs code it downloads or builds",
  },
  {
    name: "send-data",
    pattern:
      /\b(curl|wget|http|https|xh)\b.*(\s-X\s*(POST|PUT|PATCH|DELETE)\b|\s--request\s+(POST|PUT|PATCH|DELETE)\b|\s(-d|--data[\w-]*|-F|--form|-T|--upload-file|--post-data|--post-file)\b)|\bmethod\s*[:=]\s*["'](POST|PUT|PATCH|DELETE)["']|\b(requests|httpx|axios|session)\.(post|put|patch|delete)\s*\(/,
    reason: "sends data out (an upload, or a POST, PUT, PATCH or DELETE request)",
  },
  { name: "mail", pattern: /\b(sendmail|mailx|mutt|msmtp|smtplib|nodemailer)\b|\bmail\s+-s\b/, reason: "sends mail" },
  { name: "remote-copy", pattern: /\b(scp|sftp|ftp|rsync|rclone)\s|\baws\s+s3\s+(cp|mv|sync)\b|\bgsutil\s+(cp|mv|rsync)\b/, reason: "copies files to or from another machine" },
  { name: "remote-shell", pattern: /\b(ssh|mosh|telnet|nc|ncat|netcat|socat)\s/, reason: "opens a remote shell or a raw network connection" },
  {
    name: "repository",
    pattern: /\b(git|hg|svn)\s+(push|commit|merge|rebase|reset|tag)\b|\bgit\s.*\bpush\b|\bgh\s+(pr|release|repo|issue)\s+(create|merge|edit|close|delete)\b|\b(docker\s+push|npm\s+publish)\b/,
    reason: "changes or pushes to a repository",
  },
  {
    name: "database",
    pattern:
      /\b(INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|DROP\s+(TABLE|DATABASE|SCHEMA|INDEX|VIEW)|ALTER\s+TABLE|TRUNCATE\s+(TABLE\s+)?\w|CREATE\s+(TABLE|DATABASE|INDEX)|GRANT|REVOKE|MERGE\s+INTO|REPLACE\s+INTO|FLUSHALL|FLUSHDB)\b|\b(insertOne|insertMany|updateOne|updateMany|replaceOne|deleteOne|deleteMany|bulkWrite|dropDatabase)\(/i,
    reason: "changes data in a database",
  },
  {
    name: "stop-processes",
    pattern: /\b(kill|killall|pkill|taskkill|shutdown|reboot|halt|poweroff)\b|\blaunchctl\s+(stop|unload|bootout|remove|kill)\b|\bsystemctl\s+(stop|restart|kill|disable|mask)\b|\bdocker\s+(stop|kill|rm)\b|\b(process|os)\.kill\(/,
    reason: "stops processes or the machine",
  },
  {
    name: "credentials",
    pattern: /[/"']\.(ssh|aws|gnupg|kube|docker|azure|netrc|npmrc|pypirc|git-credentials)\b|\bid_(rsa|ed25519|ecdsa|dsa)\b|\bsecurity\s+(find-(generic|internet)-password|dump-keychain|export)\b|\bsecret-tool\s+lookup\b|\bkeyring\.get_password\b|\bcmdkey\b|Get-StoredCredential/,
    reason: "reads credentials (a key folder or a credential store)",
  },
  {
    name: "environment",
    pattern: /^\s*(printenv|env|set|export\s+-p|declare\s+-x)\s*($|[|>;#])|\b(printenv|env)\s*\||\bos\.environ\b(?!\s*(\[|\.get\b))|\bprocess\.env\b(?!\s*[.[])|Get-ChildItem\s+env:/i,
    reason: "reads every environment variable, the secrets included",
  },
  {
    name: "background",
    pattern: /(^|[^&])&\s*(#.*)?$|\b(nohup|disown|setsid|daemonize|crontab)\b|\b(screen|tmux)\s+(-d|new)|\bdetached\s*:\s*true\b|\bstart_new_session\s*=\s*True\b|\bos\.fork\s*\(|\.unref\s*\(\s*\)|\blaunchctl\s+(load|bootstrap|submit)\b/,
    reason: "starts something that keeps running in the background",
  },
];

export type FlaggedLine = { line: number; reasons: string[] };

/** The script's lines that match a pattern, numbered from 1, each with its reasons. */
export function flagLines(code: string): FlaggedLine[] {
  return code.split("\n").flatMap((text, i) => {
    const reasons = FLAGS.filter((f) => f.pattern.test(text)).map((f) => f.reason);
    return reasons.length > 0 ? [{ line: i + 1, reasons: [...new Set(reasons)] }] : [];
  });
}
