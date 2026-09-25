/**
 * DeepSeek Harness client half of @local/dsh-prompt-optimizer.
 *
 * Registers one compact button into `conversation.input.right` — the composer
 * tool row, directly before the send action. Clicking it optimizes the current
 * composer draft through the host-side decision pipeline and replaces the
 * draft with the enhanced prompt (the original request stays verbatim inside
 * it), then surfaces the change/assumption/warning summary as a composer
 * notice.
 *
 * Host bridge: `ctx.remote.commands.execute(sessionId, line, [])` reaches the
 * `optimize-prompt` command this bundle registers on the Host half (the
 * package's CommandResult carries the structured result back as JSON).
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-prompt-optimizer',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'promptOptimizer';
    /** Client root context, captured when the plugin applies. */
    let pluginCtx;

    const EN = {
      title: 'Optimize prompt',
      empty: 'Type a prompt first, then optimize.',
      busy: 'Optimizing…',
      success: 'Prompt optimized ({changes} changes · {assumptions} assumptions · {warnings} warnings)',
      assumed: 'Assumed',
      warnings: 'Warnings',
      error: 'Optimization failed',
    };
    const ZH = {
      title: '优化提示词',
      empty: '请先输入提示词，再点击优化。',
      busy: '优化中…',
      success: '提示词已优化（{changes} 项修改 · {assumptions} 项假设 · {warnings} 项提醒）',
      assumed: '假设',
      warnings: '提醒',
      error: '优化失败',
    };

    function fill(template, vars) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) =>
        vars && vars[key] !== undefined ? String(vars[key]) : match
      );
    }

    /** Locale translate with an English fallback if the slot supplies none. */
    function translator(t) {
      return (key, vars) => {
        if (typeof t === 'function') {
          const rendered = t(key, vars);
          if (typeof rendered === 'string' && rendered.length > 0) return rendered;
        }
        return fill(EN[key] !== undefined ? EN[key] : key, vars);
      };
    }

    function WandIcon({ busy }) {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', { d: 'M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8 19 13M17.8 6.2 19 5M3 21l9-9M12.2 6.2 11 5' }),
        busy ? h('circle', { cx: 12, cy: 12, r: 9, opacity: 0.25 }) : null
      );
    }

    function OptimizeButton({ sessionId, t }) {
      const tr = translator(t);
      const [busy, setBusy] = React.useState(false);
      const [hover, setHover] = React.useState(false);

      const onClick = async () => {
        if (busy) return;
        const sessions = pluginCtx.get('sessions');
        const conversation = pluginCtx.get('conversation');
        if (!sessions || !conversation) return;
        let input;
        try {
          const binding = sessions.binding(sessionId);
          if (!binding) throw new Error('session binding unavailable');
          input = conversation.input.for(binding.ctx);
        } catch (error) {
          console.error('prompt-optimizer: composer input unavailable', error);
          return;
        }

        let draft = '';
        try {
          draft = input.state.getSnapshot().draft;
        } catch (error) {
          console.error('prompt-optimizer: cannot read composer draft', error);
        }
        const prompt = typeof draft === 'string' ? draft.trim() : '';
        if (prompt.length === 0) {
          input.notify('info', tr('empty'));
          input.focus();
          return;
        }

        setBusy(true);
        try {
          const line =
            '/optimize-prompt ' + JSON.stringify({ prompt, response: 'json' });
          const execution = await pluginCtx.remote.commands.execute(sessionId, line, []);
          const result = execution && execution.result;
          if (!result || result.kind !== 'success') {
            input.notify('error', (result && result.text) || tr('error'));
            return;
          }
          let value;
          try {
            value = JSON.parse(result.text);
          } catch (error) {
            // Human-readable fallback (e.g. slash-command path): show as notice.
            input.notify('info', result.text);
            return;
          }
          if (!value || typeof value.optimized_prompt !== 'string') {
            input.notify('error', tr('error'));
            return;
          }
          input.setDraft(value.optimized_prompt);
          const parts = [
            tr('success', {
              changes: (value.changes || []).length,
              assumptions: (value.assumptions || []).length,
              warnings: (value.warnings || []).length,
            }),
          ];
          if (Array.isArray(value.assumptions) && value.assumptions.length > 0) {
            parts.push(`${tr('assumed')}: ${value.assumptions.join(' ')}`);
          }
          if (Array.isArray(value.warnings) && value.warnings.length > 0) {
            parts.push(`${tr('warnings')}: ${value.warnings.join(' ')}`);
          }
          input.notify('info', parts.join(' · '));
        } catch (error) {
          input.notify('error', `${tr('error')}: ${error && error.message ? error.message : ''}`);
        } finally {
          setBusy(false);
          try {
            input.focus();
          } catch (error) {
            /* focus is best-effort */
          }
        }
      };

      return h(
        'button',
        {
          type: 'button',
          title: busy ? tr('busy') : tr('title'),
          'aria-label': busy ? tr('busy') : tr('title'),
          disabled: busy,
          onClick,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            padding: 0,
            border: 'none',
            borderRadius: 8,
            cursor: busy ? 'default' : 'pointer',
            color: hover && !busy ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
            background: hover && !busy ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
            opacity: busy ? 0.5 : 1,
            transition: 'color 120ms ease, background 120ms ease',
          },
        },
        h(WandIcon, { busy })
      );
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.commands', 'sessions', 'conversation'],
      apply(ctx) {
        pluginCtx = ctx;
        ctx.effect(
          () => ctx.locale.register(NS, { zh: ZH, en: EN }),
          'prompt-optimizer: dictionaries'
        );
        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.right',
              id: 'prompt-optimizer',
              order: 30,
              locale: NS,
              inject: (sessionId) => ({ sessionId }),
            },
            OptimizeButton
          )
        );
      },
    };
  },
});
