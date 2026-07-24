# Security Policy

## Supported versions

LeanRigor is currently pre-release software. Security fixes are applied to the latest version on the `main` branch and, when releases begin, to the latest supported release line.

## Reporting a vulnerability

Please do not report suspected vulnerabilities through a public GitHub issue.

Use GitHub private vulnerability reporting when it is enabled for this repository. Until then, contact the maintainer privately through the contact route listed in [SUPPORT.md](SUPPORT.md) and clearly mark the message as a security report.

Include, where practical:

- affected version or commit;
- installation type;
- operating system and Node.js version;
- reproduction steps or proof of concept;
- potential impact;
- suggested mitigation;
- whether the issue has been disclosed elsewhere.

Do not include secrets, production credentials, private repository contents, or personal data that are not required to understand the issue.

## Response expectations

The maintainer will aim to acknowledge a report within five business days, assess severity, coordinate a fix, and agree on disclosure timing with the reporter. This is a best-effort commitment while the project is maintained by a small team.

## Security boundaries

LeanRigor can invoke coding-agent providers, shell commands, Git operations, and validation tools inside repositories. Users remain responsible for reviewing provider permissions, repository trust, configured commands, and production access.

LeanRigor intentionally does not automatically:

- create the final user commit;
- push to a remote;
- deploy;
- perform destructive production writes;
- persist hidden chain of thought.

Internal mechanical commits may exist on LeanRigor-owned branches for controlled integration. They are not pushed automatically.

## Disclosure

Please allow reasonable time for investigation and remediation before public disclosure. Security contributors will be credited unless they prefer anonymity.
