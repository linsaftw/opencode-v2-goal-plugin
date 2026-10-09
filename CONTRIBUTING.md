# Contributing

Bug fixes, reproducible integration reports, and small focused improvements are welcome.

1. Fork the repository and make a branch from `main`.
2. Follow the existing JavaScript conventions and avoid introducing runtime dependencies
   without explaining why they are necessary.
3. Add a focused regression test for every behavior change.
4. Run `npm run ci` locally. On Linux/macOS also run `bash -n install.sh uninstall.sh`.
5. Explain manual OpenCode 2 testing, including the exact CLI/server version, or mark it
   as not live-tested.
6. Open a pull request with the observed behavior, expected behavior, and test output.

Do not include credentials, private repositories, or user goal-state files in contributions.

## Scope

This plugin intentionally has no execution budget and does not bypass user permissions.
Changes to these guarantees require explicit design discussion.
