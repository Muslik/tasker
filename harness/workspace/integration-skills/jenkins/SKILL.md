---
name: jenkins
description: Jenkins reader via REST API — статус билда и его стадии, консольный лог, Allure-отчёт с упавшими тестами и выгрузкой вложений (скриншоты, видео, image-diff снепшотов). Use when user gives a Jenkins build URL or asks why CI failed, what a build did, which tests are red, or needs the actual screenshot from a failed snapshot test.
user-invocable: true
argument-hint: BUILD-URL or build number with --job/--branch
---

# Jenkins Reader

## Overview
Читает Jenkins через REST API локальными скриптами. Ничего не запускает и не перезапускает —
только чтение.

## Setup
Токен берётся из окружения, с фолбэком на `$TASKER_HARNESS_ENV_FILE`:

- `JENKINS_USER` — логин, под которым выпущен токен (например `me@onetwotrip.com`)
- `JENKINS_TOKEN` — API-токен из профиля Jenkins
- `JENKINS_BASE_URL` — опционально, по умолчанию `https://build.twiket.com`

Токен обязателен даже для чтения: анонимно приходит `403`. Передавать его нужно как
basic auth вместе с логином — с `Authorization: Bearer` Jenkins отдаёт `403`, а с неверным
логином `401`, поэтому при `401` первым делом проверь `JENKINS_USER`.

Осторожно: PR-проверки фронта живут на `build.twiket.com`, а переменная `JENKINS__BASE_URL`
(с двойным подчёркиванием) в `.env` указывает на другой инстанс — `jenkins.twiket.com`.
Этот скилл её не читает.

## Scripts
Лежат в `scripts/` рядом с этим файлом. `SC="${TASKER_SKILLS_ROOT}/jenkins/scripts"`

Все три принимают либо полный URL билда, либо номер вместе с `--job`/`--branch`, либо
`lastBuild`/`lastFailedBuild`. Для многоветочного job ветка — это `--branch`.

### Статус билда
```bash
python3 $SC/jk_build.py <BUILD-URL>                          # результат, длительность, ревизия, стадии
python3 $SC/jk_build.py 39 --job front-backoffice --branch my-branch
python3 $SC/jk_build.py --job front-backoffice --branch my-branch --builds 5   # последние билды ветки
python3 $SC/jk_build.py --job front-backoffice --branches                      # список ветвей
python3 $SC/jk_build.py <BUILD-URL> --json                                     # сырой payload
```
Стадии пайплайна приходят из отдельного `wfapi/describe` — в `/api/json` их нет. Именно по
ним видно, на чём билд встал, без чтения всего лога.

### Консольный лог
```bash
python3 $SC/jk_log.py <BUILD-URL> --tail 50
python3 $SC/jk_log.py <BUILD-URL> --grep "failed|Error" --context 3
```
Лог бывает в десятки тысяч строк — начинай с `--grep` или `--tail`, а не с полной выгрузки.

### Allure-отчёт
```bash
python3 $SC/jk_allure.py <BUILD-URL>                        # только упавшие тесты, с их uid
python3 $SC/jk_allure.py <BUILD-URL> --all                  # все тесты
python3 $SC/jk_allure.py <BUILD-URL> --case <UID>           # текст ошибки и список вложений
python3 $SC/jk_allure.py <BUILD-URL> --case <UID> --save ./out   # выгрузить вложения
```
Список тестов собирается из `data/suites.json`, детали кейса — из `data/test-cases/<uid>.json`.

## Снепшоты Playwright
Расхождение скриншота приезжает вложением типа `application/vnd.allure.image.diff`. Это не
png, а JSON с тремя data-URI, поэтому `--save` раскладывает его тремя файлами:
`<name>-expected.png` (что лежит в репозитории), `<name>-actual.png` (что отрендерил CI) и
`<name>-diff.png`.

`actual` — это готовая замена устаревшего снепшота, и часто единственный способ его получить:
локально `docker-pw` берёт публичный `mcr.microsoft.com/playwright`, а CI — свой образ
`playwright-node`, и WebKit в них рендерит по-разному, так что safari-снепшот, сгенерённый
на машине разработчика, в CI не сойдётся. Chromium к этому нечувствителен.

Перед тем как положить `actual` на место снепшота, открой его и убедись, что на картинке
нужное состояние, а не залипшая загрузка: упасть тест мог и до того, как страница дорисовалась.

## Output
После чтения отвечай по существу вопроса, а не пересказом JSON:
- **упал или нет** и на какой стадии
- **что именно сломалось** — текст ошибки теста, а не «см. лог»
- **ревизия**, на которой это случилось
- если расхождение снепшота — размеры expected и actual, чтобы было видно, разница в пикселях или в содержимом
