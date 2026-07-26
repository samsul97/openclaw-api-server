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
