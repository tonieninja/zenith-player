# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by
[SignPath Foundation](https://signpath.org).

## What gets signed

Only the Windows files built from this repository: `zenith-player.exe` (installed and portable), the
NSIS setup and the MSI. They're built by GitHub Actions ([build.yml](.github/workflows/build.yml)) from a
`v*` tag, uploaded to SignPath straight from the workflow run and signed only after a manual approval.
Nothing built on a personal machine and no third-party binaries get signed with this certificate.

Releases from before the project joined SignPath Foundation are unsigned.

## Team roles

- Committers and reviewers: [tonieninja](https://github.com/tonieninja)
- Approvers: [tonieninja](https://github.com/tonieninja)

All of them use multi-factor authentication on GitHub and SignPath.

## Privacy policy

This program will not transfer any information to other networked systems unless specifically
requested by the user or the person installing or operating it. What Zenith connects to and when is
listed in [README → Privacy](README.md#privacy).

## Changes to the system

The setup exe installs for the current Windows account, the MSI for all users. A Windows Firewall rule
for the phone remote is added only after you agree: the setup exe asks on its last page, the portable exe asks
in a dialog, the remote panel has a button, and Windows asks for administrator permission first. The setup exe's
uninstaller removes the rule; after the MSI or the portable exe, remove it in Windows Firewall.
