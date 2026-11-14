# Code signing

Windows releases are signed through [SignPath Foundation](https://signpath.org), which gives free
certificates to open source projects. Until the project is accepted, CI just skips the signing steps
and the files stay unsigned like before.

## One-time setup

1. Apply at https://signpath.org/apply with this repo. They check the "Code signing policy" section
   in the README, so it has to be there before applying.
2. Turn on 2FA for GitHub and for the SignPath account.
3. In SignPath, connect GitHub as a trusted build system for the project and create a signing
   policy (they call the default one `release-signing`).
4. Add an artifact configuration with the XML below and make it the default.
5. Create an API token for a user with the Submitter role.
6. In the GitHub repo settings:
   - secret `SIGNPATH_API_TOKEN`
   - variables `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_POLICY_SLUG`

Once `SIGNPATH_ORGANIZATION_ID` exists, every `v*` tag sends the Windows files for signing in the
release job. Someone with the Approver role has to approve it in SignPath, the job waits up to an hour.
After signing, CI regenerates the updater `.sig` files, because the Authenticode signature changes
the installer bytes.

## Artifact configuration

```xml
<?xml version="1.0" encoding="utf-8"?>
<artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
  <parameters>
    <parameter name="version" required="true" />
  </parameters>
  <zip-file>
    <pe-file-set product-name="Zenith" product-version="${version}">
      <include path="Zenith_*-setup.exe" max-matches="unbounded" />
      <include path="Zenith_*_portable.exe" max-matches="unbounded" />
      <for-each>
        <authenticode-sign />
      </for-each>
    </pe-file-set>
    <msi-file-set>
      <include path="Zenith_*.msi" max-matches="unbounded" />
      <for-each>
        <authenticode-sign />
      </for-each>
    </msi-file-set>
  </zip-file>
</artifact-configuration>
```

The app inside the NSIS installer is not signed on its own, SignPath can't open NSIS packages.
The portable exe and both installers are.
