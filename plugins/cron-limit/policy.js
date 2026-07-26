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
  return { minute, hour, recurrence: fields.slice(2).join(' ') };
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

function formatCronTime(expr) {
  const parsed = parseSimpleCron(expr);
  if (!parsed) return expr;
  return `${String(parsed.hour).padStart(2, '0')}:${String(parsed.minute).padStart(2, '0')}`;
}

export function evaluateCronCollision(
  config,
  candidateJob,
  listSchedules = activeCronSchedules,
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
    const existing = listSchedules(stateDir);
    if (schedule.kind === 'at' && schedule.at) {
      const candidateAt = Date.parse(schedule.at);
      if (!Number.isFinite(candidateAt)) return undefined;
      const conflict = existing.find((job) =>
        job.kind === 'at'
        && Number.isFinite(Date.parse(job.at))
        && Math.abs(Date.parse(job.at) - candidateAt) < minGapMinutes * 60000
      );
      if (!conflict) return undefined;
      return {
        block: true,
        blockReason: `Jadwal bentrok dengan "${conflict.name}" dalam jarak kurang dari ${minGapMinutes} menit. Tawarkan waktu lain dan minta konfirmasi user sebelum membuat cron.`,
      };
    }

    if (schedule.kind !== 'cron' || !schedule.expr) return undefined;
    const candidate = parseSimpleCron(schedule.expr);
    const candidateTz = String(schedule.tz || 'Asia/Jakarta');
    const conflict = existing.find((job) => {
      if (job.kind !== 'cron' || !job.expr) return false;
      const current = parseSimpleCron(job.expr);
      if (!candidate || !current) return job.expr === schedule.expr;
      const currentTz = String(job.tz || 'Asia/Jakarta');
      return currentTz === candidateTz
        && current.recurrence === candidate.recurrence
        && circularMinuteDistance(minuteOfDay(current), minuteOfDay(candidate)) < minGapMinutes;
    });
    if (!conflict) return undefined;

    const suggestions = [minGapMinutes, minGapMinutes * 2, minGapMinutes * 3]
      .map((offset) => shiftCronTime(conflict.expr, offset))
      .filter(Boolean)
      .map(formatCronTime);
    const alternatives = suggestions.length > 0
      ? ` Alternatif terdekat: ${suggestions.join(', ')} ${candidateTz}.`
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
