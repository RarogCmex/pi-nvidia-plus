# pi-nvidia-plus

Расширение для pi, улучшающее встроенный провайдер `nvidia` на месте
(управление thinking, актуальный каталог, нормализация запросов,
индивидуальный прокси, диагностика). Описание и команды — в `README.md`.

## Agent skills

### Issue tracker

Issues live as markdown files under `.scratch/<feature>/` — a local, gitignored working directory that is not published. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
