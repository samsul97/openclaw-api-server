import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function countCronJobs(stateDir) {
  const database = new DatabaseSync(path.join(stateDir, 'state', 'openclaw.sqlite'), {
    open: true,
    readOnly: true,
  });

  try {
    const row = database.prepare('SELECT COUNT(*) AS total FROM cron_jobs').get();
    return Number(row?.total || 0);
  } finally {
    database.close();
  }
}

export function cronJobName(stateDir, jobId) {
  const database = new DatabaseSync(path.join(stateDir, 'state', 'openclaw.sqlite'), {
    open: true,
    readOnly: true,
  });

  try {
    const row = database.prepare(
      'SELECT name FROM cron_jobs WHERE job_id = ? LIMIT 1',
    ).get(jobId);
    return String(row?.name || '');
  } finally {
    database.close();
  }
}

export function activeCronSchedules(stateDir) {
  const database = new DatabaseSync(path.join(stateDir, 'state', 'openclaw.sqlite'), {
    open: true,
    readOnly: true,
  });

  try {
    return database.prepare(
      `SELECT job_id AS id, name, schedule_kind AS kind,
              schedule_expr AS expr, schedule_tz AS tz, at
       FROM cron_jobs
       WHERE enabled = 1`,
    ).all();
  } finally {
    database.close();
  }
}

function parseSimpleCron(expr) {
  const fields = String(expr || '').trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = Number(fields[0]);
  const hour = Number(fields[1]);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59
      || !Number.isInteger(hour) || hour < 0 || hour > 23) {
    return null;
  }
  return {
    minute,
    hour,
    recurrence: fields.slice(2).join(' '),
    dayOfMonth: fields[2],
    month: fields[3],
    dayOfWeek: fields[4],
  };
}

function minuteOfDay(schedule) {
  return schedule.hour * 60 + schedule.minute;
}

function circularMinuteDistance(left, right) {
  const distance = Math.abs(left - right);
  return Math.min(distance, 1440 - distance);
}

function shiftCronTime(expr, minutes) {
  const parsed = parseSimpleCron(expr);
  if (!parsed) return null;
  const shifted = (minuteOfDay(parsed) + minutes + 1440) % 1440;
  const hour = Math.floor(shifted / 60);
  const minute = shifted % 60;
  return `${minute} ${hour} ${parsed.recurrence}`;
}

function cronWithReferenceTime(expr, referenceExpr) {
  const schedule = parseSimpleCron(expr);
  const reference = parseSimpleCron(referenceExpr);
  if (!schedule || !reference) return null;
  return `${reference.minute} ${reference.hour} ${schedule.recurrence}`;
}

function formatCronTime(expr) {
  const parsed = parseSimpleCron(expr);
  if (!parsed) return expr;
  return `${String(parsed.hour).padStart(2, '0')}:${String(parsed.minute).padStart(2, '0')}`;
}

function expandCronField(field, min, max, normalize = (value) => value) {
  const values = new Set();
  const source = String(field || '').trim();
  if (!source) return null;

  for (const part of source.split(',')) {
    const [rangePart, rawStep] = part.split('/');
    const step = rawStep === undefined ? 1 : Number(rawStep);
    if (!Number.isInteger(step) || step < 1) return null;

    let start;
    let end;
    if (rangePart === '*') {
      start = min;
      end = max;
    } else if (rangePart.includes('-')) {
      const [rawStart, rawEnd] = rangePart.split('-');
      start = Number(rawStart);
      end = Number(rawEnd);
    } else {
      start = Number(rangePart);
      end = start;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end)
        || start < min || end > max || start > end) {
      return null;
    }
    for (let value = start; value <= end; value += step) values.add(normalize(value));
  }
  return values;
}

function cronDateMatcher(schedule) {
  const months = expandCronField(schedule.month, 1, 12);
  const monthDays = expandCronField(schedule.dayOfMonth, 1, 31);
  const weekDays = expandCronField(schedule.dayOfWeek, 0, 7, (value) => value === 7 ? 0 : value);
  if (!months || !monthDays || !weekDays) return null;
  const monthDayWildcard = schedule.dayOfMonth === '*';
  const weekDayWildcard = schedule.dayOfWeek === '*';

  return (date) => {
    if (!months.has(date.getUTCMonth() + 1)) return false;
    const monthDayMatches = monthDays.has(date.getUTCDate());
    const weekDayMatches = weekDays.has(date.getUTCDay());
    if (monthDayWildcard && weekDayWildcard) return true;
    if (monthDayWildcard) return weekDayMatches;
    if (weekDayWildcard) return monthDayMatches;
    // Vixie-style cron: when both fields are restricted, either may match.
    return monthDayMatches || weekDayMatches;
  };
}

function cronRecurrencesOverlap(left, right) {
  const leftMatches = cronDateMatcher(left);
  const rightMatches = cronDateMatcher(right);
  if (!leftMatches || !rightMatches) {
    return left.recurrence === right.recurrence;
  }

  // Four years cover every weekday/month combination and a leap day.
  const start = Date.UTC(2024, 0, 1);
  for (let offset = 0; offset < 1462; offset += 1) {
    const date = new Date(start + offset * 86400000);
    if (leftMatches(date) && rightMatches(date)) return true;
  }
  return false;
}

function findRecurringConflict(expr, timezone, existing, minGapMinutes) {
  const candidate = parseSimpleCron(expr);
  return existing.find((job) => {
    if (job.kind !== 'cron' || !job.expr) return false;
    const current = parseSimpleCron(job.expr);
    if (!candidate || !current) return job.expr === expr;
    const currentTz = String(job.tz || 'Asia/Jakarta');
    return currentTz === timezone
      && cronRecurrencesOverlap(current, candidate)
      && circularMinuteDistance(minuteOfDay(current), minuteOfDay(candidate)) < minGapMinutes;
  });
}

function zonedDateParts(timestamp, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function cronMatchesInstant(expr, timezone, timestamp) {
  const schedule = parseSimpleCron(expr);
  if (!schedule) return false;
  const parts = zonedDateParts(timestamp, timezone);
  if (Number(parts.hour) !== schedule.hour || Number(parts.minute) !== schedule.minute) return false;
  const matchesDate = cronDateMatcher(schedule);
  if (!matchesDate) return false;
  return matchesDate(new Date(Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
  )));
}

function recurringOccursNearInstant(expr, timezone, instant, minGapMinutes) {
  const gapMs = minGapMinutes * 60000;
  const firstMinute = Math.floor((instant - gapMs + 1) / 60000) * 60000;
  const lastMinute = Math.ceil((instant + gapMs - 1) / 60000) * 60000;
  for (let timestamp = firstMinute; timestamp <= lastMinute; timestamp += 60000) {
    if (Math.abs(timestamp - instant) < gapMs && cronMatchesInstant(expr, timezone, timestamp)) {
      return true;
    }
  }
  return false;
}

function findOneShotConflictForRecurring(expr, timezone, existing, minGapMinutes) {
  return existing.find((job) => {
    if (job.kind !== 'at') return false;
    const instant = Date.parse(job.at);
    return Number.isFinite(instant)
      && recurringOccursNearInstant(expr, timezone, instant, minGapMinutes);
  });
}

export function evaluateCronCollision(
  config,
  candidateJob,
  listSchedules = activeCronSchedules,
  excludeJobId = '',
) {
  const stateDir = String(config.stateDir || '');
  const minGapMinutes = Number(config.minGapMinutes ?? 5);
  if (!stateDir || !Number.isInteger(minGapMinutes) || minGapMinutes < 0 || minGapMinutes > 180) {
    return {
      block: true,
      blockReason: 'Kebijakan bentrok cron tidak valid. Hubungi operator sebelum membuat reminder baru.',
    };
  }

  const schedule = candidateJob?.schedule;
  if (!schedule || typeof schedule !== 'object') return undefined;

  try {
    const existing = listSchedules(stateDir)
      .filter((job) => String(job.id || '') !== String(excludeJobId || ''));
    if (schedule.kind === 'at' && schedule.at) {
      const candidateAt = Date.parse(schedule.at);
      if (!Number.isFinite(candidateAt)) return undefined;
      const conflict = existing.find((job) => {
        if (job.kind === 'at') {
          return Number.isFinite(Date.parse(job.at))
            && Math.abs(Date.parse(job.at) - candidateAt) < minGapMinutes * 60000;
        }
        if (job.kind !== 'cron' || !job.expr) return false;
        const timezone = String(job.tz || 'Asia/Jakarta');
        return recurringOccursNearInstant(job.expr, timezone, candidateAt, minGapMinutes);
      });
      if (!conflict) return undefined;
      return {
        block: true,
        blockReason: `Jadwal bentrok dengan "${conflict.name}" dalam jarak kurang dari ${minGapMinutes} menit. Tawarkan waktu lain dan minta konfirmasi user sebelum membuat cron.`,
      };
    }

    if (schedule.kind !== 'cron' || !schedule.expr) return undefined;
    const candidate = parseSimpleCron(schedule.expr);
    const candidateTz = String(schedule.tz || 'Asia/Jakarta');
    const conflict = findRecurringConflict(schedule.expr, candidateTz, existing, minGapMinutes)
      || findOneShotConflictForRecurring(schedule.expr, candidateTz, existing, minGapMinutes);
    if (!conflict) return undefined;

    let suggestionBase = schedule.expr;
    if (conflict.kind === 'cron' && conflict.expr) {
      suggestionBase = cronWithReferenceTime(schedule.expr, conflict.expr) || schedule.expr;
    } else if (conflict.kind === 'at') {
      const instant = Date.parse(conflict.at);
      if (Number.isFinite(instant) && candidate) {
        const parts = zonedDateParts(instant, candidateTz);
        suggestionBase = `${Number(parts.minute)} ${Number(parts.hour)} ${candidate.recurrence}`;
      }
    }
    const suggestions = Array.from({ length: 36 }, (_, index) => minGapMinutes * (index + 1))
      .map((offset) => shiftCronTime(suggestionBase, offset))
      .filter(Boolean)
      .filter((expr) => !findRecurringConflict(expr, candidateTz, existing, minGapMinutes))
      .filter((expr) => !findOneShotConflictForRecurring(expr, candidateTz, existing, minGapMinutes))
      .map(formatCronTime);
    const uniqueSuggestions = [...new Set(suggestions)].slice(0, 3);
    const alternatives = uniqueSuggestions.length > 0
      ? ` Alternatif terdekat: ${uniqueSuggestions.join(', ')} ${candidateTz}.`
      : '';
    return {
      block: true,
      blockReason: `Jadwal ${formatCronTime(schedule.expr)} bentrok/terlalu dekat dengan "${conflict.name}" (minimum ${minGapMinutes} menit).${alternatives} Minta user memilih dan mengonfirmasi waktu baru; jangan mengubah jadwal otomatis.`,
    };
  } catch {
    return {
      block: true,
      blockReason: 'Jadwal cron aktif tidak dapat diverifikasi. Pembuatan reminder diblokir sementara.',
    };
  }
}

export function evaluateCronAdd(config, countJobs = countCronJobs) {
  const maxTotal = Number(config.maxTotal);
  const defaultCount = Number(config.defaultCount);
  const additionalLimit = Number(config.additionalLimit);
  const stateDir = String(config.stateDir || '');

  if (config.maxTotal === null || config.maxTotal === undefined
      || !Number.isInteger(maxTotal) || maxTotal < 0
      || !Number.isInteger(defaultCount) || defaultCount < 0
      || !Number.isInteger(additionalLimit) || additionalLimit < 0
      || maxTotal !== defaultCount + additionalLimit || !stateDir) {
    return {
      block: true,
      blockReason: 'Kebijakan batas cron client tidak valid. Hubungi operator sebelum membuat reminder baru.',
    };
  }

  try {
    const current = countJobs(stateDir);
    if (current >= maxTotal) {
      return {
        block: true,
        blockReason: `Batas cron paket tercapai (${current}/${maxTotal}). Hapus reminder yang tidak diperlukan atau upgrade paket untuk menambah kuota.`,
      };
    }
    return undefined;
  } catch {
    return {
      block: true,
      blockReason: 'Batas cron tidak dapat diverifikasi. Pembuatan reminder diblokir sementara agar kuota paket tidak terlewati.',
    };
  }
}

export function evaluateCronRemove(config, jobId, findName = cronJobName) {
  const stateDir = String(config.stateDir || '');
  if (!stateDir || !jobId) return undefined;

  try {
    const name = findName(stateDir, jobId);
    if (name.startsWith('aldo__operator_limit_test_')) {
      return {
        block: true,
        blockReason: 'Cron pengujian ini dikelola operator dan tidak boleh dihapus melalui percakapan.',
      };
    }
    return undefined;
  } catch {
    return {
      block: true,
      blockReason: 'Status kepemilikan cron tidak dapat diverifikasi. Penghapusan diblokir sementara.',
    };
  }
}
