import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { evaluateCronAdd, evaluateCronRemove } from './policy.js';

export default definePluginEntry({
  id: 'heyurassistant-cron-limit',
  name: 'HeyUrAssistant Cron Limit',
  register(api) {
    // OpenClaw exposes extension config on the registration API. Hook events
    // contain tool/runtime context, not the extension's config.
    const config = api.pluginConfig ?? {};

    api.on(
      'before_tool_call',
      async (event) => {
        if (event.toolName !== 'cron') return;

        const action = String(event.params?.action || '').toLowerCase();
        if (action === 'add') return evaluateCronAdd(config);
        if (action === 'remove') {
          return evaluateCronRemove(config, String(event.params?.jobId || event.params?.id || ''));
        }
      },
      { priority: 100, timeoutMs: 5000 },
    );
  },
});
