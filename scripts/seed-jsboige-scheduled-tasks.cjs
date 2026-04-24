#!/usr/bin/env node
/**
 * One-shot seed: migrate 2 active v1 scheduled tasks → v2 inbound.db.
 * Reads plain JS via better-sqlite3 (already a dep). Safe to re-run (idempotent).
 * Remove after bootstrap.
 */
const path = require('path');
const Database = require('better-sqlite3');
const { CronExpressionParser } = require('cron-parser');

const INBOUND_DB = path.resolve(
  'd:/nanoclaw/data/v2-sessions/ag-1776992584813-k3oj0w/sess-1776993077016-7qx60e/inbound.db',
);

const TASKS = [
  {
    id: 'task-1776840912879-659qai',
    cron: '15 6,8,10,12,14,16,18,20,22 * * *',
    prompt: `Tu es ClusterManager. Tu exécutes un tour de cluster complet.

## Étape 1 — Lire les dashboards actifs

Lit TOUS les dashboards workspace actifs (pas workspace-roo-state-manager, c'est un fantôme). Pour chaque dashboard :
- Lis la section intercom (messages récents)
- Note les timestamps — ignore les messages >24h sauf s'ils sont toujours pertinents
- Identifie les messages avec des tags [ASK], [ORDER], [URGENT], [PING] ou toute demande actionnable

## Étape 2 — Relance automatique (PROTOCOLE OBLIGATOIRE)

Pour chaque demande actionnable ([ASK], [ORDER], [URGENT], ou demande explicite sans tag) postée sur un dashboard :
- Vérifie si un [ACK] ou [SESSION] ou [DONE] a été posté EN RÉPONSE dans les 2 heures suivant la demande
- Si AUCUNE réponse de l'agent cible après 2h :
  - L'agent est considéré ENDORMI (pas simplement occupé)
  - Poste un [PING] de relance sur le dashboard de l'agent cible avec mention de la demande originale
  - Signale la situation au user via Telegram
- Si un [ACK] existe mais pas de [DONE]/[SESSION] depuis >4h :
  - L'agent est potentiellement STALLED en cours de travail
  - Poste un [CHECK] sur le dashboard pour demander un statut
- Si la demande a reçu un [DONE] ou [SESSION] : ne rien faire, la tâche est traitée

## Étape 3 — PRs et issues

Vérifie les PRs ouverts sur les repos actifs (jsboige/roo-extensions, jsboige/CoursIA, jsboige/nanoclaw, jsboige/vllm). Pour chaque PR :
- Statut (open, merged, closed)
- Commentaires récents (reviews, demandes de changes)
- Signale les PRs mergeables sans review depuis >24h

## Étape 4 — Rapport Telegram

Poste un rapport synthétique sur Telegram. Format obligatoire :
- Delta depuis tour précédent (nouvelles PRs, merges, workers actifs)
- Actions entreprises (PRs commentées, pings postés, issues créées)
- Blocages identifiés
- Si rien n'a changé : "rien de nouveau" en une ligne

RÈGLES DE QUALITÉ :
- Ne rapporte PAS les heartbeats comme activité
- Ne rapporte PAS les messages dashboard >24h comme état actuel
- Au moins une action concrète par tour si possible — sinon dis-le
- Dashboard messages sans réponse >1h = agent n'a PAS reçu, pas "il a pris note"`,
  },
  {
    id: 'task-1776880955108-aipn5v',
    cron: '0 8 * * *',
    prompt: `Tu es ClusterManager. Tu postes un bilan matinal concis à l'utilisateur via Telegram.

CONTENU :
- PRs mergées pendant la nuit (gh pr list --state merged --limit 20 sur repos actifs)
- Nouvelles PRs ouvertes par les étudiants/workers
- Anomalies détectées (agents offline, CI failures, dashboards silencieux)
- Tâches en attente de review/action

RÈGLES :
- Vérifier les timestamps des messages dashboard — ne rapporter que les événements <12h
- Si la nuit a été calme, dire "nuit calme, rien à signaler" en une ligne
- Ne PAS inventer d'activité — si rien n'a bougé, le dire
- Ne PAS rapporter les heartbeats comme activité
- Maximum 10 lignes Telegram`,
  },
];

const TZ = 'Europe/Paris';
const PLATFORM_ID = 'telegram:-5256188832';
const CHANNEL_TYPE = 'telegram';

function nextEvenSeq(db) {
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get();
  const m = row.m;
  return m < 2 ? 2 : m + 2 - (m % 2);
}

function main() {
  const db = new Database(INBOUND_DB);
  const now = new Date();
  let inserted = 0;

  for (const task of TASKS) {
    const existing = db.prepare('SELECT id FROM messages_in WHERE id = ?').get(task.id);
    if (existing) {
      console.log(`skip ${task.id} — already present`);
      continue;
    }

    const interval = CronExpressionParser.parse(task.cron, { tz: TZ });
    const nextRun = interval.next().toISOString();

    const content = JSON.stringify({ prompt: task.prompt });

    db.prepare(
      `INSERT INTO messages_in (id, seq, timestamp, status, tries, process_after, recurrence, kind, platform_id, channel_type, thread_id, content, series_id, trigger)
       VALUES (?, ?, datetime('now'), 'pending', 0, ?, ?, 'task', ?, ?, NULL, ?, ?, 1)`,
    ).run(task.id, nextEvenSeq(db), nextRun, task.cron, PLATFORM_ID, CHANNEL_TYPE, content, task.id);

    console.log(`✓ ${task.id} — next ${nextRun} (cron=${task.cron})`);
    inserted += 1;
  }

  console.log(`\n${inserted} task(s) seeded.`);
  db.close();
}

main();
