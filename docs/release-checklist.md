# SceneForge AI Release Checklist (Foundry + Forge)

Use this checklist each time you publish a new module version.

## 1) Prep the release in Git

- [ ] Update `module.json` version (example: `0.22.0`).
- [ ] Confirm `module.json` fields are correct:
  - [ ] `id`
  - [ ] `title`
  - [ ] `compatibility.minimum`
  - [ ] `compatibility.verified`
  - [ ] `url`
  - [ ] `manifest`
  - [ ] `download`
- [ ] Update changelog/release notes.
- [ ] Commit and push to `main`.

## 2) Trigger build artifacts (ZIP + release manifest)

- [ ] Create and push a version tag that matches `module.json` version:
  - [ ] `git tag 0.22.0`
  - [ ] `git push origin 0.22.0`
- [ ] Wait for GitHub Actions workflow `release-module` to complete.
- [ ] Confirm release assets were attached:
  - [ ] `sceneforge-ai.zip`
  - [ ] `module.json` (release-specific manifest with tag-based URLs)

## 3) Publish/update Foundry package release

- [ ] Open your package page in Foundry Creator tools.
- [ ] Create a new package release entry.
- [ ] Use the release asset URLs from GitHub:
  - [ ] Version Number = tag/version (example: `0.22.0`)
  - [ ] Package Manifest URL = GitHub release asset URL for `module.json`
  - [ ] Release Notes URL = GitHub release page URL
  - [ ] Required Core Version = matches `compatibility.minimum`
  - [ ] Compatible Core Version = matches `compatibility.verified`
- [ ] Publish the Foundry release.

## 4) Publish/update on The Forge (Bazaar)

- [ ] Open Forge Creator Dashboard.
- [ ] Select package (or create one if first time).
- [ ] Set/verify manifest URL to the GitHub release `module.json` asset URL.
- [ ] Confirm package type is `Module`.
- [ ] Publish/update listing and accept Creator agreement when prompted.

## 5) Post-release verification

- [ ] Install/update from Foundry package installer in a clean test world.
- [ ] Install/update from Forge in a clean test world.
- [ ] Confirm:
  - [ ] Module updates correctly.
  - [ ] Discord link flow still works.
  - [ ] Tier quota enforcement works for Tier 1 (50/month).
