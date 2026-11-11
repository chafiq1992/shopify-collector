# Collector deployment baseline

Before pushing a change that triggers a Collector deployment, uploading build
source, or rebuilding the live service, identify the image currently running
in production and the Git revision intended for the new release. Check the
running container's image tag and ID and the record for that release. Git
`main` and the build directory on the server can differ from the running
image, especially after a manual release.

Confirm that the candidate preserves live changes outside the requested scope. When
the live image lacks a verified Git revision or contains manual changes,
recover its source from release archives, saved overlays, or the running image. Check
the recovered source against the running image where possible. Reconcile the
production-only application changes into the candidate, test the combined
changes, and commit them to Git before rebuilding. Use the running release
as the baseline for unrelated features. If a production change cannot be
recovered or verified, identify the gap before replacing that release.

After deploying, verify that the expected image is running, check service
health, and exercise both the changed workflow and a recovered feature if
the release included recovered changes.
