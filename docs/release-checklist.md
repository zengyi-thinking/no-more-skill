# NMS v0.1.0 Release Checklist

## 1) Local quality gate

- [ ] `npm install`
- [ ] `npm run build`
- [ ] `npm test`
- [ ] `npm run dev -- ingest --input <sample.json>`
- [ ] `npm run dev -- flow`
- [ ] `npm run dev -- night --dry-run --time-budget 1`

## 2) Repo hygiene

- [ ] Ensure `.nms/`, `dist/`, `node_modules/` are ignored
- [ ] Remove local temp files (for example `input.json`)
- [ ] Confirm `README.md`, `SKILL.md`, `docs/demo.md` are up to date
- [ ] Confirm safety boundaries are explicit in docs

## 3) GitHub publish

- [ ] Create GitHub repo `no-more-skill`
- [ ] Add remote: `git remote add origin <repo-url>`
- [ ] Push default branch: `git push -u origin master` (or rename to `main` first)
- [ ] Create tag: `git tag v0.1.0 && git push origin v0.1.0`
- [ ] Create Release notes using `docs/launch-post.md`

## 4) First-week validation

- [ ] Validate 4 MVP criteria in real usage logs
- [ ] Collect at least 3 workflow traces from real sessions
- [ ] Validate `--apply` block behavior in non-git and protected branch scenarios
- [ ] Open issues for Phase 2 hardening and Phase 3 apply rollout
