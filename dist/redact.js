// Secret handling. Two layers:
//  1. Sensitive files (.env, keys, credentials) never have their content read into the diff at all.
//  2. Everything that is sent anywhere (AI prompt, destination) passes through redactSecrets().
const SENSITIVE_FILE = [
    /(^|\/)\.env(\.[^/]*)?$/i, // .env, .env.local, .env.production (and .env.example - values may be real)
    /(^|\/)[^/]*\.(pem|key|p12|pfx|jks|keystore|asc|gpg|ppk|kdbx|cer|crt|der)$/i,
    /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
    /(^|\/)[^/]*(credentials?|secrets?)[^/]*\.(json|ya?ml|toml|ini|xml|properties|txt|env)$/i,
    /(^|\/)(\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.htpasswd|\.dockercfg)$/i,
    /(^|\/)\.docker\/config\.json$/i,
    /(^|\/)[^/]*\.tfvars(\.json)?$/i,
    /(^|\/)terraform\.tfstate(\.backup)?$/i,
    /(^|\/)(service[-_]?account|firebase[-_]adminsdk)[^/]*\.json$/i,
    /(^|\/)google-services\.json$/i,
    /(^|\/)GoogleService-Info\.plist$/i,
    /(^|\/)\.changelog\//,
];
export const isSensitiveFile = (file) => SENSITIVE_FILE.some((re) => re.test(file));
const R = '[REDACTED]';
// [pattern, replacement]. Order matters: specific token formats before the generic key=value rule.
const PATTERNS = [
    [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----|$)/g, `${R} private key`],
    [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, R], // Anthropic
    [/\bsk-(proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g, R], // OpenAI / generic sk-
    [/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{10,}/g, R], // Stripe
    [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, R], // GitHub
    [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, R],
    [/\bglpat-[A-Za-z0-9_-]{20,}/g, R], // GitLab
    [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, R], // Slack
    [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, R], // AWS access key id
    [/\bAIza[0-9A-Za-z_-]{35}\b/g, R], // Google API key
    [/\b(secret|ntn)_[A-Za-z0-9]{30,}/g, R], // Notion
    [/\bnpm_[A-Za-z0-9]{36}\b/g, R],
    [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, R], // JWT
    [/\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g, R],
    // user:password@host in connection strings
    [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+):([^\s@'"]+)@/gi, (_m, prefix) => `${prefix}:${R}@`],
    // key = value / key: value / "key": "value" for secret-looking key names
    [
        /(["']?[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?key|credentials?|signing[_-]?key)["']?\s*(?:=|:|=>|:=)\s*)(["']?)([^\s"',;]{4,})\2/gi,
        (_m, lhs, quote) => `${lhs}${quote}${R}${quote}`,
    ],
    // Authorization: Bearer xxx
    [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{16,}/g, (m) => `${m.split(/\s+/)[0]} ${R}`],
];
export function redactSecrets(text) {
    let count = 0;
    let out = text;
    for (const [re, replacement] of PATTERNS) {
        out = out.replace(re, (...args) => {
            const match = args[0];
            // Don't count or re-redact placeholders, env references, or already-redacted values.
            if (/\[REDACTED\]|\$\{|process\.env|os\.environ|getenv|ENV\[|<[a-z_-]+>|your[-_]|example|placeholder|xxxx|\*\*\*\*|changeme/i.test(match)) {
                return match;
            }
            count++;
            return typeof replacement === 'string' ? replacement : replacement(...args);
        });
    }
    return { text: out, count };
}
export const redact = (text) => redactSecrets(text).text;
