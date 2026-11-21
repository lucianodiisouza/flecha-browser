# Nightly native build reuse

Nightlies use packages and checkpoints from this repository's default-branch `nightly-release.yml`, including artifacts from failed runs. Discovery excludes pull requests, forks, expired artifacts and the current run. Only GitHub CLI subprocesses inherit the GitHub token.

## Portable packages

Stage zero restores the built shell and host on Node 26. Linux and Windows look for a checksummed package before disk cleanup, Python setup or Windows SDK installation. A hit keeps the verified browser, replaces the shell, host and Node runtime, and writes provenance and checksums for the current source. The runner stages the package beside the release directory and promotes it after all writes succeed. Verification, copying, compression and hashing observe the reuse deadline. A failed download, invalid layout or failed promotion advances to another candidate or native preparation.

The package name includes the platform, exact native and layout fingerprints, and producing run attempt. Discovery uses exact-name API queries for first-attempt packages, rerun indexes and older unscoped packages. A rerun index identifies runs to search for later attempts. macOS always invokes Ninja and signs the app because the nightly build number is part of its native version metadata.

## Native trees

The native fingerprint covers the pinned Chromium and depot_tools revisions, patches, branding, build configuration, Windows SDK installer, source preparation, effective GN arguments with a normalized run number, platform, absolute build path, runner image and selected Xcode or Visual Studio version. Missing image metadata limits reuse to the current run. The layout fingerprint covers portable runtime staging, shell staging and packaging.

On a portable miss, the runner reclaims disk space and sets up the native toolchain. Linux uses the pinned Chromium installer's package check and checks its required locales. It runs the full noninteractive installer when needed. This step remains cancellable and stops at the existing five-hour stage deadline. On a fresh stage zero, a sparse checkout supplies the installer before Chromium preparation. Later stages use the restored checkout.

Discovery first queries the exact native snapshot name. Checkpoint indexes include an unknown stage suffix, so discovery pages through artifact names and ranks each matching run's live checkpoints by stage. Downloads use the selected immutable artifact ID directly. A restored tree must match its source SHA, native key, Chromium revision, platform and depot_tools revision. Preparation replaces the shell, writes current GN arguments, regenerates the build and records the reused source in provenance. Invalid candidates fall back before clean preparation. Cleanup touches only directories created for the attempt.

Optional discovery, restoration and repackaging share one hour across both searches. Required cleanup does not consume that hour. The five-hour stage allowance bounds reuse and leaves the rest of GitHub's six-hour job limit for handoff. Stage zero checkpoints a cold source tree. After a validated native hit it can compile immediately if time remains and the filesystems have room for another checkpoint the size of the verified input. An interrupted stage can retry from the earlier run's retained artifact.

## Checkpoints and publication

Incomplete stages upload their tree with multithreaded lossless zstd when available, otherwise gzip. Both archive formats restore under the same artifact name. A checkpoint includes Ninja logs, dependencies and filesystem metadata. A compiler error fails the build. At the compile deadline the runner waits for the owned command and inherited pipes to close before handing off. Uncertain process termination fails the stage. Each successful handoff can remove the superseded checkpoint. The final stage keeps its input for retries.

The optional full native snapshot runs on macOS or after packaging failure. Compression reserves the existing upload hour, and the upload is limited to the minutes left in the stage. Native snapshot and index failures leave required artifacts available. Artifacts have 35-day retention.

After the build job finishes, a Linux monitor dispatches the default-branch publisher with the package's immutable artifact ID, attempt-scoped name, source run, attempt and monitor job ID. The publisher verifies the platform catalog and Chromium pin at the build SHA, checks provenance and checksums, and confirms the source attempt and monitor are active before release writes. It uploads the platform checksum file last. The publisher has 60 minutes. The monitor allows another 60 minutes for queuing and cancels an unfinished publisher after an unsuccessful wait. A fresh nightly attempt must produce its own package before it can publish.
