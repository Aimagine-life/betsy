# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do not** open a public issue
2. Send details to the maintainers via [GitHub Security Advisories](https://github.com/meltymallow/betsy/security/advisories/new)
3. Include steps to reproduce and potential impact

We will acknowledge receipt within 48 hours and aim to provide a fix within 7 days for critical issues.

## Security Considerations

- API keys are stored in `~/.betsy/config.yaml` — never commit real keys
- JWT authentication uses HS256 with `node:crypto`
- Shell commands are filtered through a blocklist in `ShellTool`
- The web interface requires authentication by default
