(() => {
  "use strict";

  if (window.__deepTutorStyleWriterLoaded) return;
  window.__deepTutorStyleWriterLoaded = true;

  const PLUGIN_ID = "style-writer";
  const MESSAGE_SOURCE = "deeptutor-desktop-plugin";
  const ENTRY_ID = "dt-style-writer-entry";
  const OVERLAY_ID = "dt-style-writer-overlay";
  const STYLE_ID = "dt-style-writer-styles";
  const API_URL = "/api/v1/co_writer/edit_react";
  const DNA_CORPUS_LIMIT = 100;
  const DNA_RECOMMENDED_COUNT = 20;
  const DNA_MINIMUM_COUNT = 3;
  const LESS_AI_TONE_RULES = [
    "只做最小必要改写，未命中规则的文字逐字保留，文章结构、段落顺序、列表、引用和代码块不动。",
    "不得新增或删减事实、数字、日期、人物、来源、因果、限定词或观点。",
    "直接表达判断，清理虚立误解后再翻案的‘不是 A 而是 B’式套话。",
    "避免一个分句用两个以上顿号串起三项以上并列；必要清单不得删项。",
    "打散相邻句反复使用的同款句法，但不移动段落或删信息。",
    "只清理不必要的揭晓式破折号、提示语冒号和宣布列表的空转句。",
    "通篇三个以上序数词小标题时去掉编号，保留标题文字、顺序和层级。",
    "不用‘说白了’‘说穿了’‘先说结论’等起手式。",
    "只处理明确的翻译腔：过长前置定语、冗余‘当…时’、前置话题壳、句首连接词路标和同义复述。",
    "蒸馏 DNA 与通用去 AI 味规则冲突时，以该空间已启用的语言 DNA 为准。"
  ].join("\n- ");
  const pendingRequests = new Map();
  const dnaResources = new Map();
  let saveTimer = 0;
  let saveChain = Promise.resolve();
  let appState;
  let stateLoaded = false;
  let activeTab = "compose";

  const SPACE_PRESETS = {
    blank: {
      name: "自定义空间",
      description: "一套独立的模板、案例与个人风格记忆",
      template: "请在这里填写文章结构、目标读者、篇幅和必须遵守的内容边界。",
      styleRules: "- 使用清楚、自然的表达\n- 不编造事实、经历或数据\n- 保持前后一致"
    },
    xiaohongshu: {
      name: "小红书笔记",
      description: "真实体验、信息密度、适合移动端阅读",
      template: "标题：给出具体利益点或真实冲突，避免夸张承诺。\n开头：前 2—3 句说明场景、问题或结果。\n正文：用短段落或清单呈现 3—5 个要点，每点包含具体细节。\n结尾：自然总结或提出一个可回答的问题，不强行引导互动。\n如使用话题标签，仅保留 3—6 个高度相关标签。",
      styleRules: "- 口语自然，避免机械堆砌网络热词，除非本人样本确有此习惯\n- 一段 1—3 句，适合手机阅读\n- emoji 只作信息标记，少量使用\n- 区分亲身体验、资料信息和个人判断\n- 不编造使用经历、价格、效果或对比结果\n- 避免夸张承诺、虚假稀缺和硬性营销"
    },
    wechat: {
      name: "公众号文章",
      description: "清晰展开观点，兼顾叙事和信息价值",
      template: "标题明确主题；开头建立问题或场景；正文分层展开，每节只解决一个问题；结尾总结核心观点并自然收束。",
      styleRules: "- 兼顾可读性与信息密度\n- 小标题承担导航作用\n- 避免空洞铺垫和强行煽情\n- 不编造事实或引用"
    },
    spoken: {
      name: "视频口播",
      description: "开口自然、节奏清楚、便于直接朗读",
      template: "开头快速说明看点；中段按 3—5 个口语化要点展开；句子简短；结尾回扣主题。",
      styleRules: "- 像真实说话，不像书面报告\n- 一句话只表达一个重点\n- 用自然停顿组织节奏\n- 避免夸张承诺和无依据结论"
    }
  };

  function makeSpace(id, preset, overrides = {}) {
    return {
      id,
      name: preset.name,
      description: preset.description,
      template: preset.template,
      styleRules: preset.styleRules,
      samples: [],
      references: [],
      draft: "",
      previousDraft: "",
      brief: "",
      material: "",
      pendingCandidate: "",
      pendingTemplateCandidate: "",
      dna: { activeVersion: 0, sourceCount: 0, targetLabel: "", updatedAt: "" },
      memoryVersion: 1,
      frozen: false,
      userEdited: false,
      events: [],
      ...overrides,
      id
    };
  }

  function createDefaultState() {
    return {
      version: 3,
      activeSpaceId: "academic",
      spaces: {
        academic: makeSpace("academic", {
          name: "学术论文",
          description: "严谨、可核查、重视论证与引用边界",
          template: "使用清晰的学术结构；论点、依据和结论分明；不得编造数据、实验结果或参考文献。",
          styleRules: "- 语气客观克制，避免宣传式表达\n- 专业术语前后一致\n- 先陈述问题，再给出论证与结论\n- 没有证据时明确说明不确定性\n- 少用口语、比喻和情绪化修饰"
        }, { presetId: "academic" }),
        essay: makeSpace("essay", {
          name: "个人随笔",
          description: "自然、有个人感受，保留节奏与真实细节",
          template: "围绕一个明确感受或观察展开；允许第一人称；结构可以松弛，但要有内在线索和自然收束。",
          styleRules: "- 语气自然，不故作深沉\n- 优先使用具体经历和真实细节\n- 保留句子长短变化与停顿感\n- 避免万能总结、口号和明显的 AI 套话\n- 结尾不强行升华"
        }, { presetId: "essay" }),
        xiaohongshu: makeSpace("xiaohongshu", SPACE_PRESETS.xiaohongshu, { presetId: "xiaohongshu" })
      }
    };
  }

  appState = createDefaultState();

  function migrateState(raw) {
    const defaults = createDefaultState();
    if (!raw || typeof raw !== "object") return defaults;
    const merged = { ...defaults, ...raw, version: 3, spaces: {} };
    const rawSpaces = raw.spaces && typeof raw.spaces === "object" ? raw.spaces : {};
    const ids = [...new Set([...Object.keys(defaults.spaces), ...Object.keys(rawSpaces)])];
    for (const id of ids) {
      const incoming = rawSpaces[id];
      const fallback = defaults.spaces[id] || makeSpace(id, SPACE_PRESETS.blank, { name: incoming?.name || "自定义空间", presetId: incoming?.presetId || "custom" });
      const candidate = incoming && typeof incoming === "object" ? { ...fallback, ...incoming, id } : fallback;
      candidate.samples = Array.isArray(candidate.samples) ? candidate.samples : [];
      candidate.references = Array.isArray(candidate.references) ? candidate.references : [];
      candidate.events = Array.isArray(candidate.events) ? candidate.events : [];
      candidate.pendingTemplateCandidate = typeof candidate.pendingTemplateCandidate === "string" ? candidate.pendingTemplateCandidate : "";
      candidate.dna = candidate.dna && typeof candidate.dna === "object" ? { activeVersion: 0, sourceCount: 0, targetLabel: "", updatedAt: "", ...candidate.dna } : { activeVersion: 0, sourceCount: 0, targetLabel: "", updatedAt: "" };
      merged.spaces[id] = candidate;
    }
    if (!merged.spaces[merged.activeSpaceId]) merged.activeSpaceId = Object.keys(merged.spaces)[0] || "academic";
    return merged;
  }

  function currentSpace() {
    return appState.spaces[appState.activeSpaceId];
  }

  function requestHost(action, payload = {}) {
    return new Promise((resolve, reject) => {
      if (!window.chrome?.webview) {
        reject(new Error("当前窗口不支持桌面插件存储。"));
        return;
      }
      const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const timeout = window.setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error("插件存储响应超时。"));
      }, 8000);
      pendingRequests.set(requestId, { resolve, reject, timeout });
      window.chrome.webview.postMessage(JSON.stringify({
        source: MESSAGE_SOURCE,
        pluginId: PLUGIN_ID,
        requestId,
        action,
        ...payload
      }));
    });
  }

  if (window.chrome?.webview) {
    window.chrome.webview.addEventListener("message", event => {
      let message = event.data;
      if (typeof message === "string") {
        try { message = JSON.parse(message); } catch { return; }
      }
      if (!message || message.source !== MESSAGE_SOURCE || message.pluginId !== PLUGIN_ID) return;
      const pending = pendingRequests.get(message.requestId);
      if (!pending) return;
      window.clearTimeout(pending.timeout);
      pendingRequests.delete(message.requestId);
      if (message.ok) pending.resolve(message);
      else pending.reject(new Error(message.error || "插件操作失败。"));
    });
  }

  async function loadState() {
    if (stateLoaded) return;
    try {
      const response = await requestHost("state.load");
      const hasSavedState = response.state && typeof response.state === "object";
      appState = migrateState(response.state);
      stateLoaded = true;
      const needsMigration = hasSavedState && (response.state.version !== 3 || !response.state.spaces?.xiaohongshu);
      if (!hasSavedState || needsMigration) {
        await requestHost("state.save", { state: appState });
      }
    } catch (error) {
      stateLoaded = true;
      setStatus(error.message, "error");
    }
  }

  function queueSave(delay = 350) {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => saveState(), delay);
  }

  function saveState() {
    const snapshot = JSON.parse(JSON.stringify(appState));
    saveChain = saveChain
      .catch(() => undefined)
      .then(() => requestHost("state.save", { state: snapshot }))
      .then(() => setStatus("已保存到独立插件目录", "success"))
      .catch(error => setStatus(error.message, "error"));
    return saveChain;
  }

  function recordEvent(space, type, summary) {
    space.events.unshift({ id: crypto.randomUUID?.() || `${Date.now()}`, type, summary, at: new Date().toISOString() });
    space.events = space.events.slice(0, 100);
  }

  function isTargetRoute() {
    return /\/co[_-]writer(?:\/|$)/.test(location.pathname);
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      :root {
        --sw-bg: #fbfaf6;
        --sw-surface: #fffdf9;
        --sw-surface-2: #f5f0e7;
        --sw-ink: #2b241f;
        --sw-muted: #786e64;
        --sw-line: #e4d9ca;
        --sw-accent: #b94f18;
        --sw-accent-soft: #f6e6d8;
        --sw-success: #2f7657;
        --sw-danger: #b13d36;
        --sw-shadow: 0 20px 60px rgba(66, 46, 27, .18);
        --sw-radius-sm: 10px;
        --sw-radius: 16px;
        --sw-radius-lg: 24px;
        --sw-dur: 180ms;
        --sw-ease: cubic-bezier(.2, .8, .2, 1);
      }
      html.dark, html[data-theme="dark"], body.dark, body[data-theme="dark"] {
        --sw-bg: #1f1c19;
        --sw-surface: #29241f;
        --sw-surface-2: #332d27;
        --sw-ink: #f4eee6;
        --sw-muted: #b9ada1;
        --sw-line: #4b4138;
        --sw-accent: #dc743c;
        --sw-accent-soft: #4a2d20;
        --sw-shadow: 0 24px 70px rgba(0,0,0,.48);
      }
      #${ENTRY_ID} {
        position: relative;
        overflow: hidden;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 24px;
        margin: 16px 0 22px;
        padding: 18px 20px 18px 22px;
        border: 1px solid var(--sw-line);
        border-radius: var(--sw-radius);
        color: var(--sw-ink);
        background:
          linear-gradient(100deg, rgba(185,79,24,.08), transparent 44%),
          repeating-linear-gradient(90deg, transparent 0 31px, rgba(113,87,62,.035) 31px 32px),
          var(--sw-surface);
      }
      #${ENTRY_ID}::before {
        content: "";
        position: absolute;
        inset: 0 auto 0 0;
        width: 4px;
        background: var(--sw-accent);
      }
      .sw-entry-copy { min-width: 0; }
      .sw-entry-title { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; font-weight: 700; font-size: 17px; }
      .sw-entry-copy p { margin: 0; color: var(--sw-muted); font-size: 13px; line-height: 1.55; }
      .sw-badge { display: inline-flex; align-items: center; min-height: 24px; padding: 2px 9px; border: 1px solid #d8c8b8; border-radius: 999px; background: rgba(255,255,255,.72); color: #66584c; font-size: 12px; font-weight: 600; }
      .sw-btn { min-height: 42px; padding: 0 16px; border: 1px solid var(--sw-line); border-radius: 12px; background: var(--sw-surface); color: var(--sw-ink); font: inherit; font-weight: 600; cursor: pointer; transition: transform var(--sw-dur) var(--sw-ease), border-color var(--sw-dur), background var(--sw-dur); }
      .sw-btn:hover { border-color: #c9b49e; transform: translateY(-1px); }
      .sw-btn:focus-visible, .sw-input:focus-visible, .sw-textarea:focus-visible, .sw-select:focus-visible, .sw-space:focus-visible, .sw-tab:focus-visible { outline: 3px solid rgba(185,79,24,.25); outline-offset: 2px; }
      .sw-btn-primary { border-color: var(--sw-accent); background: var(--sw-accent); color: white; box-shadow: 0 7px 18px rgba(185,79,24,.2); }
      .sw-btn-primary:hover { background: #a74414; }
      .sw-btn:disabled { opacity: .48; cursor: not-allowed; transform: none; box-shadow: none; }
      #${OVERLAY_ID} { position: fixed; inset: 0; z-index: 2147483000; display: grid; place-items: center; padding: 26px; background: rgba(36,29,23,.36); backdrop-filter: blur(5px); animation: sw-fade var(--sw-dur) var(--sw-ease); }
      .sw-shell { width: min(1460px, 96vw); height: min(900px, 94vh); display: grid; grid-template-rows: auto 1fr; overflow: hidden; border: 1px solid var(--sw-line); border-radius: var(--sw-radius-lg); background: var(--sw-bg); color: var(--sw-ink); box-shadow: var(--sw-shadow); }
      .sw-header { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 16px 20px; border-bottom: 1px solid var(--sw-line); background: rgba(255,253,249,.94); }
      .sw-brand { display: flex; align-items: center; gap: 12px; }
      .sw-mark { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 12px; background: var(--sw-accent); color: white; font-size: 18px; font-weight: 800; }
      .sw-brand h1 { margin: 0; font-size: 18px; line-height: 1.25; }
      .sw-brand p { margin: 3px 0 0; color: var(--sw-muted); font-size: 12px; }
      .sw-header-actions { display: flex; align-items: center; gap: 10px; }
      .sw-close { width: 42px; padding: 0; font-size: 20px; }
      .sw-layout { min-height: 0; display: grid; grid-template-columns: 248px minmax(0, 1fr); }
      .sw-sidebar { min-height: 0; display: flex; flex-direction: column; gap: 18px; padding: 20px 16px; border-right: 1px solid var(--sw-line); background: #f6f1e8; }
      .sw-sidebar-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0 4px 8px; }
      .sw-sidebar-head .sw-kicker { margin: 0; }
      .sw-btn-mini { min-height: 30px; padding: 0 10px; border-radius: 9px; font-size: 11px; }
      .sw-kicker { margin: 0 4px 8px; color: var(--sw-muted); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
      .sw-space-list { display: grid; gap: 9px; }
      .sw-space { width: 100%; padding: 13px 14px; border: 1px solid transparent; border-radius: 14px; background: transparent; color: var(--sw-ink); text-align: left; cursor: pointer; }
      .sw-space:hover { background: rgba(255,255,255,.65); }
      .sw-space[aria-selected="true"] { border-color: #dcc7b4; background: var(--sw-surface); box-shadow: 0 8px 20px rgba(73,52,31,.07); }
      .sw-space strong { display: block; margin-bottom: 4px; font-size: 14px; }
      .sw-space span { display: block; color: var(--sw-muted); font-size: 11px; line-height: 1.45; }
      .sw-isolation { margin-top: auto; padding: 14px; border: 1px solid #d8cbbd; border-radius: 14px; background: rgba(255,255,255,.58); }
      .sw-isolation strong { display: flex; align-items: center; gap: 7px; font-size: 12px; }
      .sw-isolation strong::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--sw-success); box-shadow: 0 0 0 4px rgba(47,118,87,.12); }
      .sw-isolation p { margin: 8px 0 0; color: var(--sw-muted); font-size: 11px; line-height: 1.55; }
      .sw-main { min-width: 0; min-height: 0; overflow: auto; padding: 20px 24px 28px; }
      .sw-topline { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; margin-bottom: 16px; }
      .sw-topline h2 { margin: 0; font-size: 22px; }
      .sw-topline p { margin: 5px 0 0; color: var(--sw-muted); font-size: 13px; }
      .sw-top-actions { display: flex; align-items: center; gap: 8px; }
      .sw-tabs { display: inline-flex; gap: 3px; padding: 3px; border: 1px solid var(--sw-line); border-radius: 12px; background: var(--sw-surface-2); }
      .sw-tab { min-height: 34px; padding: 0 12px; border: 0; border-radius: 9px; background: transparent; color: var(--sw-muted); font: inherit; font-size: 12px; cursor: pointer; }
      .sw-tab[aria-selected="true"] { background: var(--sw-surface); color: var(--sw-ink); box-shadow: 0 2px 7px rgba(54,42,31,.09); }
      .sw-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 16px; }
      .sw-stat { padding: 11px 13px; border: 1px solid var(--sw-line); border-radius: 12px; background: var(--sw-surface); }
      .sw-stat span { display: block; color: var(--sw-muted); font-size: 11px; }
      .sw-stat strong { display: block; margin-top: 4px; font-size: 16px; }
      .sw-grid { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(310px, .65fr); gap: 16px; align-items: start; }
      .sw-card { border: 1px solid var(--sw-line); border-radius: var(--sw-radius); background: var(--sw-surface); }
      .sw-card-header { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 14px 16px 11px; border-bottom: 1px solid #eee5da; }
      .sw-card-header h3 { margin: 0; font-size: 14px; }
      .sw-card-body { padding: 14px 16px 16px; }
      .sw-field { display: grid; gap: 7px; margin-bottom: 13px; }
      .sw-field:last-child { margin-bottom: 0; }
      .sw-label { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: #514840; font-size: 12px; font-weight: 650; }
      .sw-help { color: var(--sw-muted); font-size: 10px; font-weight: 400; }
      .sw-input, .sw-textarea, .sw-select { width: 100%; box-sizing: border-box; border: 1px solid #ddd2c5; border-radius: 11px; background: #fffefa; color: var(--sw-ink); font: inherit; font-size: 13px; line-height: 1.6; }
      .sw-input, .sw-select { height: 42px; padding: 0 12px; }
      .sw-textarea { min-height: 96px; padding: 10px 12px; resize: vertical; }
      .sw-draft { min-height: 300px; font-family: "Microsoft YaHei UI", "Segoe UI", sans-serif; font-size: 14px; line-height: 1.8; }
      .sw-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; margin-top: 12px; }
      .sw-ai-label { color: var(--sw-accent); font-size: 11px; font-weight: 700; }
      .sw-checkbox { display: flex; align-items: flex-start; gap: 8px; color: var(--sw-muted); font-size: 11px; line-height: 1.45; }
      .sw-checkbox input { margin-top: 2px; accent-color: var(--sw-accent); }
      .sw-candidate { margin-top: 12px; padding: 12px; border: 1px solid #d9c4af; border-radius: 12px; background: #fbf2e8; }
      .sw-candidate h4 { margin: 0 0 8px; font-size: 12px; }
      .sw-candidate .sw-textarea { min-height: 140px; }
      .sw-memory-view, .sw-dna-view { display: none; }
      .sw-memory-view[data-active="true"], .sw-compose-view[data-active="true"], .sw-dna-view[data-active="true"] { display: block; }
      .sw-compose-view[data-active="false"] { display: none; }
      .sw-event-list { display: grid; gap: 8px; margin-top: 12px; }
      .sw-event { display: grid; grid-template-columns: 92px 1fr auto; gap: 10px; align-items: center; padding: 10px 12px; border: 1px solid var(--sw-line); border-radius: 11px; background: var(--sw-surface); font-size: 11px; }
      .sw-event code { color: var(--sw-accent); font-family: Consolas, monospace; }
      .sw-event time { color: var(--sw-muted); }
      .sw-reference-layout { display: grid; grid-template-columns: minmax(300px, .9fr) minmax(0, 1.1fr); gap: 18px; }
      .sw-reference-list { display: grid; gap: 9px; max-height: 390px; overflow: auto; padding-right: 3px; }
      .sw-reference { padding: 11px 12px; border: 1px solid var(--sw-line); border-radius: 11px; background: var(--sw-bg); }
      .sw-reference-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
      .sw-reference strong { display: block; font-size: 12px; }
      .sw-reference p { margin: 7px 0 0; color: var(--sw-muted); font-size: 11px; line-height: 1.55; }
      .sw-reference-meta { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 7px; color: var(--sw-muted); font-size: 10px; }
      .sw-reference-meta a { color: var(--sw-accent); }
      .sw-note { margin: 0; padding: 10px 12px; border-left: 3px solid var(--sw-accent); border-radius: 0 9px 9px 0; background: var(--sw-accent-soft); color: var(--sw-muted); font-size: 11px; line-height: 1.6; }
      .sw-dialog-layer { position: absolute; inset: 0; z-index: 5; display: grid; place-items: center; padding: 20px; background: rgba(36,29,23,.38); backdrop-filter: blur(3px); }
      .sw-mini-dialog { width: min(680px, 94vw); max-height: min(820px, 90vh); overflow: auto; padding: 20px; border: 1px solid var(--sw-line); border-radius: 18px; background: var(--sw-surface); box-shadow: var(--sw-shadow); }
      .sw-mini-dialog h2 { margin: 0 0 6px; font-size: 19px; }
      .sw-mini-dialog > p { margin: 0 0 17px; color: var(--sw-muted); font-size: 12px; line-height: 1.6; }
      .sw-preset-box { margin-bottom: 17px; padding: 12px; border: 1px dashed #d8c8b8; border-radius: 12px; background: var(--sw-bg); }
      .sw-preset-box > p { margin: 8px 0 0; color: var(--sw-muted); font-size: 10px; line-height: 1.5; }
      .sw-preset-row { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 8px; }
      .sw-preset-chip { min-height: 34px; padding: 0 11px; border: 1px solid var(--sw-line); border-radius: 999px; background: var(--sw-surface); color: var(--sw-muted); font: inherit; font-size: 11px; cursor: pointer; }
      .sw-preset-chip[aria-pressed="true"] { border-color: #c48762; background: var(--sw-accent-soft); color: var(--sw-accent); font-weight: 700; }
      .sw-dialog-grid { display: grid; grid-template-columns: .7fr 1.3fr; gap: 12px; }
      .sw-dialog-textarea { min-height: 108px; }
      .sw-dialog-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 18px; }
      .sw-dialog-actions > div { display: flex; gap: 9px; }
      .sw-btn-danger { border-color: #d9aaa5; color: var(--sw-danger); }
      .sw-dna-rail { display: grid; grid-template-columns: repeat(6, minmax(0,1fr)); gap: 6px; margin: 0 0 16px; }
      .sw-dna-step { position: relative; min-height: 58px; padding: 10px 9px; border: 1px solid var(--sw-line); border-radius: 11px; background: var(--sw-surface); }
      .sw-dna-step::after { content: ""; position: absolute; left: 9px; right: 9px; bottom: 7px; height: 3px; border-radius: 99px; background: #e7ddd2; }
      .sw-dna-step[data-ready="true"]::after { background: var(--sw-success); }
      .sw-dna-step strong { display: block; color: var(--sw-accent); font-size: 10px; }
      .sw-dna-step span { display: block; margin-top: 3px; color: var(--sw-muted); font-size: 10px; line-height: 1.3; }
      .sw-dna-dashboard { display: grid; grid-template-columns: minmax(0,1.25fr) minmax(300px,.75fr); gap: 16px; align-items: start; }
      .sw-dna-metrics { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 8px; margin-bottom: 13px; }
      .sw-meter { height: 8px; overflow: hidden; border-radius: 999px; background: #e9dfd5; }
      .sw-meter > span { display: block; height: 100%; border-radius: inherit; background: var(--sw-accent); transition: width var(--sw-dur) var(--sw-ease); }
      .sw-corpus-list { display: grid; gap: 8px; max-height: 420px; overflow: auto; }
      .sw-corpus-item { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 12px; padding: 11px 12px; border: 1px solid var(--sw-line); border-radius: 11px; background: var(--sw-bg); }
      .sw-corpus-item strong { display: block; font-size: 12px; }
      .sw-corpus-item p { margin: 5px 0 0; color: var(--sw-muted); font-size: 10px; line-height: 1.5; }
      .sw-corpus-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; color: var(--sw-muted); font-size: 10px; }
      .sw-dna-editor { margin-top: 16px; }
      .sw-dna-layer-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 12px; }
      .sw-dna-layer { padding: 12px; border: 1px solid var(--sw-line); border-radius: 12px; background: var(--sw-bg); }
      .sw-dna-layer:last-child { grid-column: 1 / -1; }
      .sw-dna-layer h4 { display: flex; justify-content: space-between; gap: 8px; margin: 0 0 8px; font-size: 12px; }
      .sw-dna-layer .sw-textarea { min-height: 180px; }
      .sw-dna-version-list { display: grid; gap: 7px; }
      .sw-dna-version { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 10px; border: 1px solid var(--sw-line); border-radius: 10px; color: var(--sw-muted); font-size: 10px; }
      .sw-file-input { display: block; width: 100%; box-sizing: border-box; padding: 9px; border: 1px dashed #d3c1af; border-radius: 11px; color: var(--sw-muted); background: var(--sw-bg); font: inherit; font-size: 11px; }
      .sw-file-input::file-selector-button { min-height: 32px; margin-right: 10px; padding: 0 11px; border: 1px solid var(--sw-line); border-radius: 8px; background: var(--sw-surface); color: var(--sw-ink); font: inherit; cursor: pointer; }
      .sw-empty { padding: 28px; border: 1px dashed #d8ccbd; border-radius: 14px; color: var(--sw-muted); text-align: center; font-size: 12px; }
      .sw-status { min-width: 160px; color: var(--sw-muted); font-size: 11px; text-align: right; }
      .sw-status[data-kind="success"] { color: var(--sw-success); }
      .sw-status[data-kind="error"] { color: var(--sw-danger); }
      .sw-busy::after { content: ""; display: inline-block; width: 10px; height: 10px; margin-left: 7px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; vertical-align: -1px; animation: sw-spin .8s linear infinite; }
      html.dark .sw-header, html[data-theme="dark"] .sw-header, body.dark .sw-header, body[data-theme="dark"] .sw-header { background: rgba(41,36,31,.96); }
      html.dark .sw-sidebar, html[data-theme="dark"] .sw-sidebar, body.dark .sw-sidebar, body[data-theme="dark"] .sw-sidebar { background: #25211d; }
      html.dark .sw-input, html.dark .sw-textarea, html.dark .sw-select, html[data-theme="dark"] .sw-input, html[data-theme="dark"] .sw-textarea, html[data-theme="dark"] .sw-select, body.dark .sw-input, body.dark .sw-textarea, body.dark .sw-select, body[data-theme="dark"] .sw-input, body[data-theme="dark"] .sw-textarea, body[data-theme="dark"] .sw-select { background: #211e1b; color: var(--sw-ink); border-color: var(--sw-line); }
      html.dark .sw-label, html[data-theme="dark"] .sw-label, body.dark .sw-label, body[data-theme="dark"] .sw-label { color: var(--sw-ink); }
      html.dark .sw-candidate, html[data-theme="dark"] .sw-candidate, body.dark .sw-candidate, body[data-theme="dark"] .sw-candidate { background: #382a21; border-color: #664733; }
      @keyframes sw-fade { from { opacity: 0; } to { opacity: 1; } }
      @keyframes sw-spin { to { transform: rotate(360deg); } }
      @media (max-width: 980px) {
        #${OVERLAY_ID} { padding: 10px; }
        .sw-shell { width: 100%; height: 98vh; }
        .sw-layout { grid-template-columns: 190px minmax(0,1fr); }
        .sw-grid { grid-template-columns: 1fr; }
        .sw-reference-layout { grid-template-columns: 1fr; }
        .sw-stats { grid-template-columns: repeat(2, minmax(0,1fr)); }
        .sw-dialog-grid { grid-template-columns: 1fr; gap: 0; }
        .sw-dna-dashboard, .sw-dna-layer-grid { grid-template-columns: 1fr; }
        .sw-dna-layer:last-child { grid-column: auto; }
        .sw-dna-rail { grid-template-columns: repeat(3,minmax(0,1fr)); }
      }
      @media (prefers-reduced-motion: reduce) {
        #${OVERLAY_ID}, .sw-btn, .sw-busy::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; }
      }
    `;
    document.head.appendChild(style);
  }

  function ensureEntry() {
    if (!isTargetRoute()) {
      document.getElementById(ENTRY_ID)?.remove();
      closeWorkspace();
      return;
    }
    if (document.getElementById(ENTRY_ID)) return;
    const main = document.querySelector("main");
    if (!main) return;
    ensureStyles();
    const entry = document.createElement("section");
    entry.id = ENTRY_ID;
    entry.setAttribute("aria-label", "风格写作插件");
    entry.innerHTML = `
      <div class="sw-entry-copy">
        <div class="sw-entry-title">风格写作 <span class="sw-badge">隔离插件</span></div>
        <p>为论文、随笔、小红书或任意场景创建独立空间；案例与个人风格分开保存。</p>
      </div>
      <button class="sw-btn sw-btn-primary" type="button" data-sw-open>打开风格写作</button>
    `;
    entry.querySelector("[data-sw-open]").addEventListener("click", openWorkspace);
    const insertionPoint = main.children.length > 1 ? main.children[1] : null;
    main.insertBefore(entry, insertionPoint);
  }

  async function openWorkspace() {
    await loadState();
    ensureStyles();
    if (!document.getElementById(OVERLAY_ID)) buildWorkspace();
    renderWorkspace();
    if (document.body) document.body.style.overflow = "hidden";
    document.getElementById(OVERLAY_ID)?.querySelector("[data-sw-close]")?.focus();
  }

  function closeWorkspace() {
    document.getElementById(OVERLAY_ID)?.remove();
    if (document.body) document.body.style.overflow = "";
  }

  function makeSpaceId() {
    return `space-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  function openSpaceDialog(mode) {
    const root = document.getElementById(OVERLAY_ID);
    if (!root || root.querySelector("[data-sw-dialog-layer]")) return;
    syncVisibleValues();
    const editing = mode === "edit";
    const space = currentSpace();
    const layer = document.createElement("div");
    layer.className = "sw-dialog-layer";
    layer.dataset.swDialogLayer = "";
    layer.innerHTML = `
      <section class="sw-mini-dialog" role="dialog" aria-modal="true" aria-labelledby="sw-space-dialog-title">
        <h2 id="sw-space-dialog-title">${editing ? "编辑写作空间" : "新建写作空间"}</h2>
        <p>${editing ? "这里可以直接修改空间的用途、文章结构和初始风格。" : "直接填写下面四项即可完全自定义；快捷预设只是可选填充，不是必选类型。"}</p>
        ${editing ? "" : `<div class="sw-preset-box"><span class="sw-label">可选：快速填充</span><div class="sw-preset-row" data-sw-preset-row><button class="sw-preset-chip" type="button" aria-pressed="true" data-sw-preset="custom">完全自定义</button><button class="sw-preset-chip" type="button" aria-pressed="false" data-sw-preset="xiaohongshu">小红书笔记</button><button class="sw-preset-chip" type="button" aria-pressed="false" data-sw-preset="wechat">公众号文章</button><button class="sw-preset-chip" type="button" aria-pressed="false" data-sw-preset="spoken">视频口播</button></div><p>点击预设只会把内容填入下方，你仍可逐字修改；“完全自定义”会清空所有字段。</p></div>`}
        <div class="sw-dialog-grid">
          <label class="sw-field"><span class="sw-label">空间名称</span><input class="sw-input" data-sw-space-dialog-name maxlength="40" placeholder="例如：旅行观察、产品测评、读书卡片"></label>
          <label class="sw-field"><span class="sw-label">用途、读者与目标</span><input class="sw-input" data-sw-space-dialog-description maxlength="140" placeholder="写给谁、解决什么问题、希望呈现什么感觉"></label>
        </div>
        <label class="sw-field"><span class="sw-label">文章结构模板 <span class="sw-help">完全自由，可留空以后再写</span></span><textarea class="sw-textarea sw-dialog-textarea" data-sw-space-dialog-template maxlength="4000" placeholder="例如：标题如何写；开头几句做什么；正文分几段；结尾如何收束……"></textarea></label>
        <label class="sw-field"><span class="sw-label">初始风格规则 <span class="sw-help">每行一条，可留空</span></span><textarea class="sw-textarea sw-dialog-textarea" data-sw-space-dialog-rules maxlength="4000" placeholder="例如：\n- 语气像朋友分享，不喊口号\n- 多用具体细节，少用抽象总结\n- 不编造亲身经历"></textarea></label>
        ${editing && space.frozen ? `<p class="sw-note">当前空间已冻结。名称和用途仍可修改，模板与风格规则需先在创作台解除冻结。</p>` : ""}
        <div class="sw-dialog-actions">
          <div>${editing && Object.keys(appState.spaces).length > 1 && !["academic", "essay", "xiaohongshu"].includes(space.id) ? `<button class="sw-btn sw-btn-danger" type="button" data-sw-delete-space>删除空间</button>` : ""}</div>
          <div><button class="sw-btn" type="button" data-sw-dialog-cancel>取消</button><button class="sw-btn sw-btn-primary" type="button" data-sw-dialog-save>${editing ? "保存" : "创建空间"}</button></div>
        </div>
      </section>
    `;
    root.appendChild(layer);
    const nameInput = layer.querySelector("[data-sw-space-dialog-name]");
    const descriptionInput = layer.querySelector("[data-sw-space-dialog-description]");
    const templateInput = layer.querySelector("[data-sw-space-dialog-template]");
    const rulesInput = layer.querySelector("[data-sw-space-dialog-rules]");
    let selectedPresetId = editing ? (space.presetId || "custom") : "custom";
    nameInput.value = editing ? space.name : "";
    descriptionInput.value = editing ? space.description : "";
    templateInput.value = editing ? space.template : "";
    rulesInput.value = editing ? space.styleRules : "";
    templateInput.disabled = Boolean(editing && space.frozen);
    rulesInput.disabled = Boolean(editing && space.frozen);
    const closeDialog = () => layer.remove();
    layer.addEventListener("click", event => { if (event.target === layer) closeDialog(); });
    layer.addEventListener("keydown", event => { if (event.key === "Escape") { event.stopPropagation(); closeDialog(); } });
    layer.querySelector("[data-sw-dialog-cancel]").addEventListener("click", closeDialog);
    layer.querySelectorAll("[data-sw-preset]").forEach(button => button.addEventListener("click", () => {
      selectedPresetId = button.dataset.swPreset;
      layer.querySelectorAll("[data-sw-preset]").forEach(item => item.setAttribute("aria-pressed", String(item === button)));
      const preset = selectedPresetId === "custom" ? { name: "", description: "", template: "", styleRules: "" } : SPACE_PRESETS[selectedPresetId];
      nameInput.value = preset.name;
      descriptionInput.value = preset.description;
      templateInput.value = preset.template;
      rulesInput.value = preset.styleRules;
      nameInput.focus();
    }));
    layer.querySelector("[data-sw-dialog-save]").addEventListener("click", () => {
      const name = nameInput.value.trim();
      const description = descriptionInput.value.trim();
      const template = templateInput.value.trim();
      const styleRules = rulesInput.value.trim();
      if (name.length < 2) { setStatus("空间名称至少需要 2 个字。", "error"); nameInput.focus(); return; }
      if (editing) {
        const rulesChanged = !space.frozen && (space.template !== template || space.styleRules !== styleRules);
        space.name = name.slice(0, 40);
        space.description = description.slice(0, 140) || "独立自定义写作空间";
        if (!space.frozen) {
          space.template = template.slice(0, 4000);
          space.styleRules = styleRules.slice(0, 4000);
        }
        if (rulesChanged) space.memoryVersion += 1;
        recordEvent(space, "space.updated", rulesChanged ? `更新空间定义与风格至 v${space.memoryVersion}` : "更新空间名称或用途");
      } else {
        const id = makeSpaceId();
        appState.spaces[id] = makeSpace(id, SPACE_PRESETS.blank, {
          name: name.slice(0, 40),
          description: description.slice(0, 140) || "独立自定义写作空间",
          template: template.slice(0, 4000),
          styleRules: styleRules.slice(0, 4000),
          presetId: selectedPresetId
        });
        appState.activeSpaceId = id;
        activeTab = "compose";
        recordEvent(appState.spaces[id], "space.created", `创建“${name.slice(0, 40)}”写作空间`);
      }
      queueSave(0);
      closeDialog();
      renderWorkspace();
    });
    layer.querySelector("[data-sw-delete-space]")?.addEventListener("click", async () => {
      if (!window.confirm(`确定删除“${space.name}”吗？该空间的样本、案例、DNA 和草稿也会一并删除。`)) return;
      const deletedName = space.name;
      try { await requestHost("directory.delete", { path: dnaBasePath(space.id) }); } catch (error) { setStatus(`DNA 目录清理失败：${error.message}`, "error"); return; }
      dnaResources.delete(space.id);
      delete appState.spaces[space.id];
      appState.activeSpaceId = Object.keys(appState.spaces)[0];
      queueSave(0);
      closeDialog();
      renderWorkspace();
      setStatus(`已删除“${deletedName}”`, "success");
    });
    nameInput.focus();
    nameInput.select();
  }

  function buildWorkspace() {
    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "sw-title");
    overlay.innerHTML = `
      <div class="sw-shell">
        <header class="sw-header">
          <div class="sw-brand">
            <div class="sw-mark" aria-hidden="true">文</div>
            <div><h1 id="sw-title">风格写作</h1><p>独立空间 · 受控学习 · 随时可移除</p></div>
          </div>
          <div class="sw-header-actions"><span class="sw-status" data-sw-status>正在读取插件数据…</span><span class="sw-badge">隔离开启</span><button class="sw-btn sw-close" type="button" aria-label="关闭风格写作" data-sw-close>×</button></div>
        </header>
        <div class="sw-layout">
          <aside class="sw-sidebar" aria-label="写作空间">
            <div><div class="sw-sidebar-head"><p class="sw-kicker">写作空间</p><button class="sw-btn sw-btn-mini" type="button" data-sw-new-space>＋ 新建</button></div><div class="sw-space-list" data-sw-spaces></div></div>
            <div class="sw-isolation"><strong>记忆边界正常</strong><p>当前空间只读取自己的模板、样本和风格规则，不写入 DeepTutor 全局记忆。</p></div>
          </aside>
          <main class="sw-main">
            <div class="sw-topline">
              <div><h2 data-sw-space-name></h2><p data-sw-space-description></p></div>
              <div class="sw-top-actions"><button class="sw-btn sw-btn-mini" type="button" data-sw-edit-space>编辑空间</button><div class="sw-tabs" role="tablist" aria-label="工作台视图"><button class="sw-tab" type="button" role="tab" data-sw-tab="compose">创作台</button><button class="sw-tab" type="button" role="tab" data-sw-tab="memory">风格记忆</button><button class="sw-tab" type="button" role="tab" data-sw-tab="dna">Writing DNA</button></div></div>
            </div>
            <div class="sw-stats"><div class="sw-stat"><span>L1 写作事件</span><strong data-sw-event-count>0</strong></div><div class="sw-stat"><span>本人样本</span><strong data-sw-sample-count>0</strong></div><div class="sw-stat"><span>参考案例</span><strong data-sw-reference-count>0</strong></div><div class="sw-stat"><span>L3 风格版本</span><strong data-sw-version>v1</strong></div></div>
            <section class="sw-compose-view" data-sw-compose-view data-active="true">
              <div class="sw-grid">
                <div class="sw-card">
                  <div class="sw-card-header"><h3>创作任务</h3><span class="sw-ai-label">AI 生成内容可编辑</span></div>
                  <div class="sw-card-body">
                    <label class="sw-field"><span class="sw-label">你想写什么 <span class="sw-help">主题、目标、篇幅</span></span><textarea class="sw-textarea" data-sw-brief placeholder="例如：写一篇 1200 字的课程论文引言，讨论……"></textarea></label>
                    <label class="sw-field"><span class="sw-label">已有材料 <span class="sw-help">可选，不会写入风格记忆</span></span><textarea class="sw-textarea" data-sw-material placeholder="粘贴事实、提纲或需要使用的材料"></textarea></label>
                    <div class="sw-actions"><button class="sw-btn sw-btn-primary" type="button" data-sw-generate>按此风格生成</button><button class="sw-btn" type="button" data-sw-polish>按此风格润色当前稿</button></div>
                  </div>
                </div>
                <div class="sw-card">
                  <div class="sw-card-header"><h3>当前风格约束</h3><label class="sw-checkbox"><input type="checkbox" data-sw-frozen> 冻结记忆</label></div>
                  <div class="sw-card-body"><label class="sw-field"><span class="sw-label">模板规则</span><textarea class="sw-textarea" data-sw-template></textarea></label><label class="sw-field"><span class="sw-label">稳定风格（L3）</span><textarea class="sw-textarea" data-sw-rules></textarea></label><button class="sw-btn" type="button" data-sw-save-rules>保存风格规则</button></div>
                </div>
              </div>
              <div class="sw-card" style="margin-top:16px">
                <div class="sw-card-header"><h3>生成结果</h3><span class="sw-ai-label" data-sw-origin>尚未生成</span></div>
                <div class="sw-card-body"><textarea class="sw-textarea sw-draft" data-sw-draft placeholder="生成的正文会出现在这里。你可以直接修改，系统不会自动学习。"></textarea><div class="sw-actions"><button class="sw-btn" type="button" data-sw-copy>复制正文</button><button class="sw-btn" type="button" data-sw-undo>撤回上次生成</button><button class="sw-btn" type="button" data-sw-less-ai>按 DNA 去 AI 味</button></div><div style="margin-top:12px"><label class="sw-checkbox"><input type="checkbox" data-sw-final-confirm> 我确认这是经过我修改或认可的定稿，可以分析写作风格</label><button class="sw-btn" style="margin-top:9px" type="button" data-sw-learn>分析这份定稿</button></div><div class="sw-candidate" data-sw-candidate-box hidden><h4>候选风格规律（确认后才进入当前空间）</h4><textarea class="sw-textarea" data-sw-candidate></textarea><div class="sw-actions"><button class="sw-btn sw-btn-primary" type="button" data-sw-accept-candidate>确认加入风格</button><button class="sw-btn" type="button" data-sw-discard-candidate>放弃</button></div></div></div>
              </div>
            </section>
            <section class="sw-memory-view" data-sw-memory-view data-active="false">
              <div class="sw-grid">
                <div class="sw-card"><div class="sw-card-header"><h3>导入本人写作样本</h3><span class="sw-badge">只进入当前空间</span></div><div class="sw-card-body"><label class="sw-field"><span class="sw-label">粘贴你本人写过的文字</span><textarea class="sw-textarea" style="min-height:220px" data-sw-sample-input placeholder="建议一次导入一篇或一个完整段落，至少 80 字。"></textarea></label><label class="sw-checkbox"><input type="checkbox" data-sw-sample-confirm> 我确认这是本人创作或本人最终定稿，不是未经修改的 AI 输出</label><button class="sw-btn sw-btn-primary" style="margin-top:12px" type="button" data-sw-add-sample>加入当前空间</button></div></div>
                <div class="sw-card"><div class="sw-card-header"><h3>记忆说明</h3></div><div class="sw-card-body"><p style="margin:0;color:var(--sw-muted);font-size:12px;line-height:1.8">L1 保存生成、修改和确认事件；本人样本只保存你主动确认的文字；L3 只保存你批准的风格规律。每个写作空间的模板、样本、案例和提示上下文完全分开。</p><div style="margin-top:14px" class="sw-stat"><span>最近本人样本</span><strong style="font-size:12px;line-height:1.5" data-sw-last-sample>暂无</strong></div></div></div>
              </div>
              <div class="sw-card" style="margin-top:16px">
                <div class="sw-card-header"><h3>优秀案例库</h3><span class="sw-badge">不进入个人风格</span></div>
                <div class="sw-card-body">
                  <p class="sw-note">粘贴公开案例并保留来源。原文只用于分析结构、开头和信息节奏；正常生成不会读取案例原文，只有你手动应用的模板候选才会生效。</p>
                  <div class="sw-reference-layout" style="margin-top:14px">
                    <div>
                      <label class="sw-field"><span class="sw-label">案例标题</span><input class="sw-input" data-sw-reference-title maxlength="100" placeholder="例如：高收藏的本地部署教程"></label>
                      <label class="sw-field"><span class="sw-label">来源链接 <span class="sw-help">可选，用于追溯</span></span><input class="sw-input" data-sw-reference-url maxlength="500" placeholder="https://..."></label>
                      <label class="sw-field"><span class="sw-label">标签 <span class="sw-help">逗号分隔</span></span><input class="sw-input" data-sw-reference-tags maxlength="120" placeholder="教程, AI, 本地部署"></label>
                      <label class="sw-field"><span class="sw-label">案例正文</span><textarea class="sw-textarea" style="min-height:180px" data-sw-reference-text maxlength="12000" placeholder="粘贴一篇优秀笔记，至少 80 字。"></textarea></label>
                      <label class="sw-checkbox"><input type="checkbox" data-sw-reference-confirm> 我确认仅用于分析可复用结构，不直接复制原文，并保留必要的来源信息</label>
                      <button class="sw-btn" style="margin-top:12px" type="button" data-sw-add-reference>保存为参考案例</button>
                    </div>
                    <div>
                      <div class="sw-reference-list" data-sw-reference-list></div>
                      <button class="sw-btn" style="margin-top:12px" type="button" data-sw-extract-template>AI 提炼模板候选</button>
                      <div class="sw-candidate" data-sw-template-candidate-box hidden><h4>模板候选（手动应用后才会生效）</h4><textarea class="sw-textarea" data-sw-template-candidate></textarea><div class="sw-actions"><button class="sw-btn sw-btn-primary" type="button" data-sw-apply-template>应用为当前模板</button><button class="sw-btn" type="button" data-sw-discard-template>放弃</button></div></div>
                    </div>
                  </div>
                </div>
              </div>
              <div class="sw-card" style="margin-top:16px"><div class="sw-card-header"><h3>L1 最近事件</h3></div><div class="sw-card-body"><div class="sw-event-list" data-sw-events></div></div></div>
            </section>
            <section class="sw-dna-view" data-sw-dna-view data-active="false">
              <div class="sw-dna-rail" aria-label="Writing DNA 六层蒸馏流程">
                <div class="sw-dna-step" data-sw-dna-step="language"><strong>L1</strong><span>语言与节奏</span></div>
                <div class="sw-dna-step" data-sw-dna-step="structure"><strong>L2</strong><span>文章结构</span></div>
                <div class="sw-dna-step" data-sw-dna-step="topic"><strong>L3</strong><span>选题逻辑</span></div>
                <div class="sw-dna-step" data-sw-dna-step="material"><strong>L4</strong><span>素材策略</span></div>
                <div class="sw-dna-step" data-sw-dna-step="cognitive"><strong>L5</strong><span>认知框架</span></div>
                <div class="sw-dna-step" data-sw-dna-step="visual"><strong>L6</strong><span>视觉呈现</span></div>
              </div>
              <div class="sw-dna-dashboard">
                <div class="sw-card">
                  <div class="sw-card-header"><h3>本地语料库</h3><span class="sw-badge">当前空间独享</span></div>
                  <div class="sw-card-body">
                    <div class="sw-dialog-grid">
                      <label class="sw-field"><span class="sw-label">语料身份</span><select class="sw-select" data-sw-dna-kind><option value="self">我的作品</option><option value="reference">参考作者/账号</option></select></label>
                      <label class="sw-field"><span class="sw-label">作者或账号 <span class="sw-help">参考语料必填</span></span><input class="sw-input" data-sw-dna-author maxlength="80" placeholder="例如：某个小红书账号"></label>
                    </div>
                    <label class="sw-field"><span class="sw-label">批量导入 Markdown / TXT</span><input class="sw-file-input" type="file" accept=".md,.txt,text/markdown,text/plain" multiple data-sw-dna-files></label>
                    <div class="sw-actions"><button class="sw-btn" type="button" data-sw-dna-import-files>导入所选文件</button><button class="sw-btn" type="button" data-sw-dna-import-samples>导入本空间已有本人样本</button></div>
                    <div style="height:1px;background:var(--sw-line);margin:16px 0"></div>
                    <label class="sw-field"><span class="sw-label">单篇标题</span><input class="sw-input" data-sw-dna-title maxlength="160" placeholder="文章标题"></label>
                    <label class="sw-field"><span class="sw-label">主题标签 <span class="sw-help">逗号分隔</span></span><input class="sw-input" data-sw-dna-tags maxlength="200" placeholder="AI, 教程, 工具测评"></label>
                    <label class="sw-field"><span class="sw-label">直接粘贴正文</span><textarea class="sw-textarea" style="min-height:160px" data-sw-dna-text maxlength="200000" placeholder="粘贴一篇完整文章，至少 120 字。"></textarea></label>
                    <label class="sw-checkbox"><input type="checkbox" data-sw-dna-confirm> 我确认本人作品归我所有；参考作品仅用于风格分析，不复制其中的事实与表达</label>
                    <button class="sw-btn" style="margin-top:12px" type="button" data-sw-dna-add>保存到语料库</button>
                    <div class="sw-corpus-list" style="margin-top:16px" data-sw-dna-corpus-list></div>
                  </div>
                </div>
                <div class="sw-card">
                  <div class="sw-card-header"><h3>蒸馏控制台</h3><span class="sw-ai-label">AI 生成 · 人工启用</span></div>
                  <div class="sw-card-body">
                    <div class="sw-dna-metrics"><div class="sw-stat"><span>全部语料</span><strong data-sw-dna-total>0</strong></div><div class="sw-stat"><span>当前对象</span><strong data-sw-dna-target-count>0</strong></div><div class="sw-stat"><span>启用版本</span><strong data-sw-dna-version>—</strong></div></div>
                    <label class="sw-field"><span class="sw-label">本次蒸馏对象</span><select class="sw-select" data-sw-dna-target></select></label>
                    <div class="sw-field"><span class="sw-label">语料完整度 <span class="sw-help" data-sw-dna-confidence>未准备</span></span><div class="sw-meter"><span data-sw-dna-meter style="width:0%"></span></div></div>
                    <p class="sw-note">至少 3 篇可以试运行，20 篇以上更稳定。一次完整蒸馏会调用模型 5 次，并生成可编辑候选，不会自动覆盖现有风格。</p>
                    <button class="sw-btn sw-btn-primary" style="margin-top:14px" type="button" data-sw-dna-distill>开始六层蒸馏</button>
                    <div style="margin-top:18px"><span class="sw-label">历史版本</span><div class="sw-dna-version-list" style="margin-top:8px" data-sw-dna-versions></div></div>
                  </div>
                </div>
              </div>
              <div class="sw-card sw-dna-editor" data-sw-dna-editor hidden>
                <div class="sw-card-header"><h3>Writing DNA 候选</h3><span class="sw-ai-label">请逐项审核后启用</span></div>
                <div class="sw-card-body">
                  <div class="sw-dna-layer-grid">
                    <label class="sw-dna-layer"><h4>L1 语言 DNA <span class="sw-ai-label">AI-generated</span></h4><textarea class="sw-textarea" data-sw-dna-layer="language"></textarea></label>
                    <label class="sw-dna-layer"><h4>L2 文章结构模板 <span class="sw-ai-label">AI-generated</span></h4><textarea class="sw-textarea" data-sw-dna-layer="structure"></textarea></label>
                    <label class="sw-dna-layer"><h4>L3-L5 写作视角与认知框架 <span class="sw-ai-label">AI-generated</span></h4><textarea class="sw-textarea" data-sw-dna-layer="cognitive"></textarea></label>
                    <label class="sw-dna-layer"><h4>L6 视觉风格指南 <span class="sw-ai-label">AI-generated</span></h4><textarea class="sw-textarea" data-sw-dna-layer="visual"></textarea></label>
                    <label class="sw-dna-layer"><h4>Writing-DNA.md 整合文档 <span class="sw-ai-label">AI-generated</span></h4><textarea class="sw-textarea" data-sw-dna-layer="summary"></textarea></label>
                  </div>
                  <label class="sw-checkbox" style="margin-top:14px"><input type="checkbox" data-sw-dna-approve> 我已检查并认可这组 DNA，可以用于当前空间后续创作</label>
                  <div class="sw-actions"><button class="sw-btn sw-btn-primary" type="button" data-sw-dna-activate>启用此 DNA 版本</button><button class="sw-btn" type="button" data-sw-dna-discard>放弃候选</button></div>
                </div>
              </div>
            </section>
          </main>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", event => { if (event.target === overlay) closeWorkspace(); });
    overlay.querySelector("[data-sw-close]").addEventListener("click", closeWorkspace);
    overlay.querySelector("[data-sw-new-space]").addEventListener("click", () => openSpaceDialog("create"));
    overlay.querySelector("[data-sw-edit-space]").addEventListener("click", () => openSpaceDialog("edit"));
    overlay.querySelectorAll("[data-sw-tab]").forEach(button => button.addEventListener("click", () => { activeTab = button.dataset.swTab; renderWorkspace(); }));
    overlay.querySelector("[data-sw-generate]").addEventListener("click", () => generateDraft(false));
    overlay.querySelector("[data-sw-polish]").addEventListener("click", () => generateDraft(true));
    overlay.querySelector("[data-sw-copy]").addEventListener("click", copyDraft);
    overlay.querySelector("[data-sw-undo]").addEventListener("click", undoDraft);
    overlay.querySelector("[data-sw-less-ai]").addEventListener("click", cleanAiTone);
    overlay.querySelector("[data-sw-save-rules]").addEventListener("click", saveRules);
    overlay.querySelector("[data-sw-learn]").addEventListener("click", analyzeFinalDraft);
    overlay.querySelector("[data-sw-accept-candidate]").addEventListener("click", acceptCandidate);
    overlay.querySelector("[data-sw-discard-candidate]").addEventListener("click", discardCandidate);
    overlay.querySelector("[data-sw-add-sample]").addEventListener("click", addSample);
    overlay.querySelector("[data-sw-add-reference]").addEventListener("click", addReference);
    overlay.querySelector("[data-sw-extract-template]").addEventListener("click", extractTemplateCandidate);
    overlay.querySelector("[data-sw-apply-template]").addEventListener("click", applyTemplateCandidate);
    overlay.querySelector("[data-sw-discard-template]").addEventListener("click", discardTemplateCandidate);
    overlay.querySelector("[data-sw-dna-kind]").addEventListener("change", updateDnaAuthorInput);
    overlay.querySelector("[data-sw-dna-target]").addEventListener("change", event => { dnaResource(currentSpace().id).targetKey = event.target.value; renderDnaView(); });
    overlay.querySelector("[data-sw-dna-import-files]").addEventListener("click", importDnaFiles);
    overlay.querySelector("[data-sw-dna-import-samples]").addEventListener("click", importExistingSamplesToDna);
    overlay.querySelector("[data-sw-dna-add]").addEventListener("click", addDnaDocumentFromPaste);
    overlay.querySelector("[data-sw-dna-distill]").addEventListener("click", distillWritingDna);
    overlay.querySelector("[data-sw-dna-activate]").addEventListener("click", activateDnaCandidate);
    overlay.querySelector("[data-sw-dna-discard]").addEventListener("click", discardDnaCandidate);
    overlay.querySelector("[data-sw-frozen]").addEventListener("change", event => { currentSpace().frozen = event.target.checked; recordEvent(currentSpace(), "memory.freeze", event.target.checked ? "冻结风格记忆" : "解除风格冻结"); queueSave(0); renderWorkspace(); });
    bindDraftInputs(overlay);
    document.addEventListener("keydown", handleEscape, { once: true });
  }

  function bindDraftInputs(root) {
    const mappings = [
      ["[data-sw-brief]", "brief"],
      ["[data-sw-material]", "material"],
      ["[data-sw-template]", "template"]
    ];
    for (const [selector, key] of mappings) {
      root.querySelector(selector).addEventListener("input", event => { currentSpace()[key] = event.target.value; queueSave(); });
    }
    root.querySelector("[data-sw-rules]").addEventListener("input", event => { currentSpace().styleRules = event.target.value; });
    root.querySelector("[data-sw-draft]").addEventListener("input", event => { const space = currentSpace(); space.draft = event.target.value; space.userEdited = true; root.querySelector("[data-sw-final-confirm]").checked = false; queueSave(); updateOriginLabel(); });
  }

  function handleEscape(event) {
    if (event.key === "Escape") closeWorkspace();
    else if (document.getElementById(OVERLAY_ID)) document.addEventListener("keydown", handleEscape, { once: true });
  }

  function renderWorkspace() {
    const root = document.getElementById(OVERLAY_ID);
    if (!root) return;
    const space = currentSpace();
    const spaces = root.querySelector("[data-sw-spaces]");
    spaces.replaceChildren(...Object.values(appState.spaces).map(item => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sw-space";
      button.setAttribute("aria-selected", String(item.id === space.id));
      const strong = document.createElement("strong");
      strong.textContent = item.name;
      const span = document.createElement("span");
      span.textContent = `${item.samples.length} 本人 · ${item.references.length} 参考 · DNA ${item.dna?.activeVersion ? `v${item.dna.activeVersion}` : "未启用"}`;
      button.append(strong, span);
      button.addEventListener("click", () => { syncVisibleValues(); appState.activeSpaceId = item.id; activeTab = "compose"; queueSave(0); renderWorkspace(); });
      return button;
    }));
    root.querySelector("[data-sw-space-name]").textContent = space.name;
    root.querySelector("[data-sw-space-description]").textContent = space.description;
    root.querySelector("[data-sw-event-count]").textContent = String(space.events.length);
    root.querySelector("[data-sw-sample-count]").textContent = String(space.samples.length);
    root.querySelector("[data-sw-reference-count]").textContent = String(space.references.length);
    root.querySelector("[data-sw-version]").textContent = `v${space.memoryVersion}`;
    root.querySelector("[data-sw-brief]").value = space.brief;
    root.querySelector("[data-sw-material]").value = space.material;
    root.querySelector("[data-sw-template]").value = space.template;
    root.querySelector("[data-sw-rules]").value = space.styleRules;
    root.querySelector("[data-sw-draft]").value = space.draft;
    root.querySelector("[data-sw-frozen]").checked = space.frozen;
    root.querySelector("[data-sw-rules]").disabled = space.frozen;
    root.querySelector("[data-sw-save-rules]").disabled = space.frozen;
    root.querySelector("[data-sw-learn]").disabled = space.frozen || !space.draft.trim();
    root.querySelector("[data-sw-less-ai]").disabled = !space.draft.trim();
    const candidateBox = root.querySelector("[data-sw-candidate-box]");
    candidateBox.hidden = !space.pendingCandidate;
    root.querySelector("[data-sw-candidate]").value = space.pendingCandidate;
    const templateCandidateBox = root.querySelector("[data-sw-template-candidate-box]");
    templateCandidateBox.hidden = !space.pendingTemplateCandidate;
    root.querySelector("[data-sw-template-candidate]").value = space.pendingTemplateCandidate;
    root.querySelectorAll("[data-sw-tab]").forEach(button => button.setAttribute("aria-selected", String(button.dataset.swTab === activeTab)));
    root.querySelector("[data-sw-compose-view]").dataset.active = String(activeTab === "compose");
    root.querySelector("[data-sw-memory-view]").dataset.active = String(activeTab === "memory");
    root.querySelector("[data-sw-dna-view]").dataset.active = String(activeTab === "dna");
    const last = space.samples[0];
    root.querySelector("[data-sw-last-sample]").textContent = last ? `${last.text.slice(0, 70).replace(/\s+/g, " ")}${last.text.length > 70 ? "…" : ""}` : "暂无";
    renderReferences(root, space);
    renderEvents(root, space);
    updateOriginLabel();
    setStatus("已保存到独立插件目录", "success");
    if (activeTab === "dna") {
      renderDnaView();
      const resource = dnaResource(space.id);
      if (!resource.loaded && !resource.loading) window.setTimeout(() => loadDnaResources(space.id), 0);
    }
  }

  function renderReferences(root, space) {
    const list = root.querySelector("[data-sw-reference-list]");
    if (!space.references.length) {
      const empty = document.createElement("div");
      empty.className = "sw-empty";
      empty.textContent = "还没有参考案例。可先粘贴一篇优秀笔记，并保留来源链接。";
      list.replaceChildren(empty);
      root.querySelector("[data-sw-extract-template]").disabled = true;
      return;
    }
    root.querySelector("[data-sw-extract-template]").disabled = false;
    list.replaceChildren(...space.references.map(reference => {
      const card = document.createElement("article");
      card.className = "sw-reference";
      const head = document.createElement("div");
      head.className = "sw-reference-head";
      const title = document.createElement("strong");
      title.textContent = reference.title || "未命名案例";
      const remove = document.createElement("button");
      remove.className = "sw-btn sw-btn-mini";
      remove.type = "button";
      remove.textContent = "移除";
      remove.setAttribute("aria-label", `移除参考案例：${reference.title || "未命名案例"}`);
      remove.addEventListener("click", () => removeReference(reference.id));
      head.append(title, remove);
      const preview = document.createElement("p");
      preview.textContent = `${reference.text.slice(0, 110).replace(/\s+/g, " ")}${reference.text.length > 110 ? "…" : ""}`;
      const meta = document.createElement("div");
      meta.className = "sw-reference-meta";
      if (reference.tags) {
        const tags = document.createElement("span");
        tags.textContent = reference.tags;
        meta.appendChild(tags);
      }
      if (reference.url) {
        const link = document.createElement("a");
        link.href = reference.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "查看来源";
        meta.appendChild(link);
      }
      card.append(head, preview, meta);
      return card;
    }));
  }

  function dnaResource(spaceId) {
    if (!dnaResources.has(spaceId)) {
      dnaResources.set(spaceId, { loaded: false, loading: false, documents: [], profile: null, draft: null, versions: [], targetKey: "self" });
    }
    return dnaResources.get(spaceId);
  }

  function dnaBasePath(spaceId) {
    return `dna/${spaceId}`;
  }

  async function readJsonFile(path) {
    const response = await requestHost("file.read", { path });
    return JSON.parse(response.content);
  }

  function writeJsonFile(path, value) {
    return requestHost("file.write", { path, content: JSON.stringify(value, null, 2) });
  }

  async function loadDnaResources(spaceId, force = false) {
    const resource = dnaResource(spaceId);
    if (resource.loading || (resource.loaded && !force)) return resource;
    resource.loading = true;
    renderDnaView();
    try {
      const base = dnaBasePath(spaceId);
      const [corpusListing, baseListing, versionListing] = await Promise.all([
        requestHost("file.list", { path: `${base}/corpus` }),
        requestHost("file.list", { path: base }),
        requestHost("file.list", { path: `${base}/versions` })
      ]);
      const documents = [];
      for (const file of corpusListing.files || []) {
        try { documents.push(await readJsonFile(file.path)); } catch { /* skip a damaged corpus item */ }
      }
      documents.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
      const baseNames = new Set((baseListing.files || []).map(file => file.name));
      const profile = baseNames.has("profile.json") ? await readJsonFile(`${base}/profile.json`).catch(() => null) : null;
      const draft = baseNames.has("draft.json") ? await readJsonFile(`${base}/draft.json`).catch(() => null) : null;
      const versions = [];
      for (const file of (versionListing.files || []).sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt))).slice(0, 30)) {
        try { versions.push({ ...(await readJsonFile(file.path)), _path: file.path }); } catch { /* skip damaged version */ }
      }
      resource.documents = documents;
      resource.profile = profile;
      resource.draft = draft;
      resource.versions = versions;
      resource.targetKey = draft?.targetKey || profile?.targetKey || resource.targetKey || "self";
      resource.loaded = true;
      currentSpace().dna.sourceCount = currentSpace().id === spaceId ? documents.length : currentSpace().dna.sourceCount;
      renderDnaView();
      return resource;
    } catch (error) {
      setStatus(`Writing DNA 读取失败：${error.message}`, "error");
      throw error;
    } finally {
      resource.loading = false;
      renderDnaView();
    }
  }

  function updateDnaAuthorInput() {
    const root = document.getElementById(OVERLAY_ID);
    if (!root) return;
    const reference = root.querySelector("[data-sw-dna-kind]").value === "reference";
    const author = root.querySelector("[data-sw-dna-author]");
    author.disabled = !reference;
    author.placeholder = reference ? "例如：某个小红书账号" : "本人作品无需填写";
  }

  function dnaTargetKey(document) {
    return document.kind === "reference" ? `reference:${String(document.author || "").trim().toLowerCase()}` : "self";
  }

  function dnaTargets(documents) {
    const targets = [{ key: "self", label: "我的作品" }];
    const seen = new Set(["self"]);
    for (const document of documents) {
      const key = dnaTargetKey(document);
      if (!seen.has(key) && document.author) {
        seen.add(key);
        targets.push({ key, label: `参考作者：${document.author}` });
      }
    }
    return targets;
  }

  function renderDnaView() {
    const root = document.getElementById(OVERLAY_ID);
    if (!root) return;
    const space = currentSpace();
    const resource = dnaResource(space.id);
    const list = root.querySelector("[data-sw-dna-corpus-list]");
    root.querySelector("[data-sw-dna-total]").textContent = String(resource.documents.length);
    root.querySelector("[data-sw-dna-version]").textContent = resource.profile?.version ? `v${resource.profile.version}` : "—";
    updateDnaAuthorInput();

    const targetSelect = root.querySelector("[data-sw-dna-target]");
    const targets = dnaTargets(resource.documents);
    const desired = targets.some(item => item.key === resource.targetKey) ? resource.targetKey : "self";
    targetSelect.replaceChildren(...targets.map(target => {
      const option = document.createElement("option");
      option.value = target.key;
      option.textContent = target.label;
      return option;
    }));
    targetSelect.value = desired;
    resource.targetKey = desired;
    const selectedDocuments = resource.documents.filter(document => dnaTargetKey(document) === desired);
    const targetLabel = targets.find(item => item.key === desired)?.label || "我的作品";
    root.querySelector("[data-sw-dna-target-count]").textContent = String(selectedDocuments.length);
    const percent = Math.min(100, Math.round((selectedDocuments.length / DNA_RECOMMENDED_COUNT) * 100));
    root.querySelector("[data-sw-dna-meter]").style.width = `${percent}%`;
    const confidence = selectedDocuments.length >= DNA_RECOMMENDED_COUNT ? "稳定：已达到 20 篇" : selectedDocuments.length >= 10 ? "中等：建议继续补充" : selectedDocuments.length >= DNA_MINIMUM_COUNT ? "较低：可以试运行" : `不足：至少还需 ${DNA_MINIMUM_COUNT - selectedDocuments.length} 篇`;
    root.querySelector("[data-sw-dna-confidence]").textContent = confidence;
    root.querySelector("[data-sw-dna-distill]").disabled = resource.loading || selectedDocuments.length < DNA_MINIMUM_COUNT || space.frozen;

    if (resource.loading && !resource.loaded) {
      const loading = document.createElement("div");
      loading.className = "sw-empty";
      loading.textContent = "正在读取本地 Writing DNA 语料…";
      list.replaceChildren(loading);
    } else if (!resource.documents.length) {
      const empty = document.createElement("div");
      empty.className = "sw-empty";
      empty.textContent = "还没有语料。可批量导入 Markdown/TXT，或复用本空间已有本人样本。";
      list.replaceChildren(empty);
    } else {
      list.replaceChildren(...resource.documents.map(item => {
        const article = document.createElement("article");
        article.className = "sw-corpus-item";
        const copy = document.createElement("div");
        const title = document.createElement("strong");
        title.textContent = item.title || "未命名文章";
        const preview = document.createElement("p");
        preview.textContent = `${String(item.text || "").slice(0, 90).replace(/\s+/g, " ")}${String(item.text || "").length > 90 ? "…" : ""}`;
        const meta = document.createElement("div");
        meta.className = "sw-corpus-meta";
        meta.textContent = `${item.kind === "reference" ? item.author || "参考作者" : "我的作品"} · ${String(item.text || "").length} 字${item.tags ? ` · ${item.tags}` : ""}`;
        copy.append(title, preview, meta);
        const remove = document.createElement("button");
        remove.className = "sw-btn sw-btn-mini";
        remove.type = "button";
        remove.textContent = "移除";
        remove.addEventListener("click", () => removeDnaDocument(item));
        article.append(copy, remove);
        return article;
      }));
    }

    const activeLayers = resource.draft?.layers || resource.profile?.layers || {};
    root.querySelectorAll("[data-sw-dna-step]").forEach(step => {
      const key = step.dataset.swDnaStep;
      const ready = key === "topic" || key === "material" ? Boolean(activeLayers.cognitive) : Boolean(activeLayers[key]);
      step.dataset.ready = String(ready);
    });

    const editor = root.querySelector("[data-sw-dna-editor]");
    editor.hidden = !resource.draft;
    if (resource.draft) {
      for (const key of ["language", "structure", "cognitive", "visual", "summary"]) {
        root.querySelector(`[data-sw-dna-layer="${key}"]`).value = resource.draft.layers?.[key] || "";
      }
      root.querySelector("[data-sw-dna-approve]").checked = false;
    }

    const versionList = root.querySelector("[data-sw-dna-versions]");
    if (!resource.versions.length) {
      const empty = document.createElement("div");
      empty.className = "sw-empty";
      empty.style.padding = "14px";
      empty.textContent = "暂无已启用版本";
      versionList.replaceChildren(empty);
    } else {
      versionList.replaceChildren(...resource.versions.slice(0, 8).map(version => {
        const row = document.createElement("div");
        row.className = "sw-dna-version";
        const label = document.createElement("span");
        label.textContent = `v${version.version} · ${version.targetLabel || targetLabel} · ${version.sourceCount || 0} 篇`;
        const button = document.createElement("button");
        button.className = "sw-btn sw-btn-mini";
        button.type = "button";
        button.textContent = "载入审核";
        button.addEventListener("click", () => loadDnaVersionForReview(version));
        row.append(label, button);
        return row;
      }));
    }
  }

  function validateDnaIdentity() {
    const root = document.getElementById(OVERLAY_ID);
    const kind = root.querySelector("[data-sw-dna-kind]").value;
    const author = root.querySelector("[data-sw-dna-author]").value.trim();
    if (kind === "reference" && author.length < 2) {
      setStatus("参考语料需要填写作者或账号名称。", "error");
      return null;
    }
    if (!root.querySelector("[data-sw-dna-confirm]").checked) {
      setStatus("请先确认语料来源和使用边界。", "error");
      return null;
    }
    return { kind, author: kind === "reference" ? author.slice(0, 80) : "" };
  }

  async function persistDnaDocument(document) {
    const space = currentSpace();
    const resource = dnaResource(space.id);
    if (resource.documents.length >= DNA_CORPUS_LIMIT) throw new Error(`当前空间最多保存 ${DNA_CORPUS_LIMIT} 篇语料。`);
    await writeJsonFile(`${dnaBasePath(space.id)}/corpus/doc-${document.id}.json`, document);
    resource.documents.unshift(document);
    space.dna.sourceCount = resource.documents.length;
    recordEvent(space, "dna.corpus.added", `加入 DNA 语料“${document.title}”`);
  }

  async function addDnaDocumentFromPaste() {
    const root = document.getElementById(OVERLAY_ID);
    const identity = validateDnaIdentity();
    if (!identity) return;
    const textInput = root.querySelector("[data-sw-dna-text]");
    const text = textInput.value.trim();
    if (text.length < 120) { setStatus("DNA 语料至少需要 120 字，建议使用完整文章。", "error"); return; }
    const titleInput = root.querySelector("[data-sw-dna-title]");
    const tagsInput = root.querySelector("[data-sw-dna-tags]");
    const document = {
      id: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      title: titleInput.value.trim().slice(0, 160) || `未命名文章 ${new Date().toLocaleDateString("zh-CN")}`,
      tags: tagsInput.value.trim().slice(0, 200),
      text: text.slice(0, 200000),
      ...identity,
      createdAt: new Date().toISOString()
    };
    try {
      await persistDnaDocument(document);
      titleInput.value = "";
      tagsInput.value = "";
      textInput.value = "";
      root.querySelector("[data-sw-dna-confirm]").checked = false;
      queueSave(0);
      renderDnaView();
      setStatus("语料已保存到当前空间的独立 DNA 目录", "success");
    } catch (error) {
      setStatus(error.message, "error");
    }
  }

  async function importDnaFiles() {
    const root = document.getElementById(OVERLAY_ID);
    const identity = validateDnaIdentity();
    if (!identity) return;
    const input = root.querySelector("[data-sw-dna-files]");
    const files = [...(input.files || [])];
    if (!files.length) { setStatus("请先选择 Markdown 或 TXT 文件。", "error"); return; }
    const resource = dnaResource(currentSpace().id);
    if (resource.documents.length + files.length > DNA_CORPUS_LIMIT) { setStatus(`导入后会超过 ${DNA_CORPUS_LIMIT} 篇上限。`, "error"); return; }
    const button = root.querySelector("[data-sw-dna-import-files]");
    setBusy(button, true);
    let imported = 0;
    try {
      for (const file of files) {
        const text = (await file.text()).trim();
        if (text.length < 120) continue;
        const document = {
          id: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          title: file.name.replace(/\.(md|txt)$/i, "").slice(0, 160),
          tags: "",
          text: text.slice(0, 200000),
          ...identity,
          sourceFile: file.name.slice(0, 240),
          createdAt: new Date().toISOString()
        };
        await persistDnaDocument(document);
        imported += 1;
      }
      input.value = "";
      root.querySelector("[data-sw-dna-confirm]").checked = false;
      queueSave(0);
      renderDnaView();
      setStatus(`已导入 ${imported} 篇语料；过短文件已跳过`, imported ? "success" : "error");
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      setBusy(button, false);
    }
  }

  async function importExistingSamplesToDna() {
    const space = currentSpace();
    if (!space.samples.length) { setStatus("当前空间还没有本人样本。", "error"); return; }
    const resource = dnaResource(space.id);
    const existing = new Set(resource.documents.map(document => document.originSampleId).filter(Boolean));
    const samples = space.samples.filter(sample => !existing.has(sample.id));
    if (!samples.length) { setStatus("已有本人样本都已导入 DNA 语料库。", "success"); return; }
    if (resource.documents.length + samples.length > DNA_CORPUS_LIMIT) { setStatus(`导入后会超过 ${DNA_CORPUS_LIMIT} 篇上限。`, "error"); return; }
    try {
      let imported = 0;
      for (const sample of samples) {
        const document = {
          id: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          title: `本人样本 ${imported + 1}`,
          tags: "旧风格样本",
          text: String(sample.text || "").slice(0, 200000),
          kind: "self",
          author: "",
          originSampleId: sample.id,
          createdAt: sample.createdAt || new Date().toISOString()
        };
        await persistDnaDocument(document);
        imported += 1;
      }
      queueSave(0);
      renderDnaView();
      setStatus(`已复制 ${imported} 篇本人样本到 DNA 语料库`, "success");
    } catch (error) {
      setStatus(error.message, "error");
    }
  }

  async function removeDnaDocument(document) {
    if (!window.confirm(`移除 DNA 语料“${document.title}”吗？已生成的历史 DNA 版本不会被删除。`)) return;
    const space = currentSpace();
    const resource = dnaResource(space.id);
    try {
      await requestHost("file.delete", { path: `${dnaBasePath(space.id)}/corpus/doc-${document.id}.json` });
      resource.documents = resource.documents.filter(item => item.id !== document.id);
      space.dna.sourceCount = resource.documents.length;
      recordEvent(space, "dna.corpus.removed", `移除 DNA 语料“${document.title}”`);
      queueSave(0);
      renderDnaView();
    } catch (error) {
      setStatus(error.message, "error");
    }
  }

  function corpusForModel(documents) {
    return documents.map((document, index) => [
      `【文章 ${index + 1}】`,
      `标题：${document.title}`,
      `身份：${document.kind === "reference" ? document.author : "用户本人"}`,
      document.tags ? `标签：${document.tags}` : "",
      String(document.text || "").slice(0, 12000)
    ].filter(Boolean).join("\n")).join("\n\n---\n\n");
  }

  async function saveDnaDraft(space, resource) {
    await writeJsonFile(`${dnaBasePath(space.id)}/draft.json`, resource.draft);
    renderDnaView();
  }

  async function distillWritingDna() {
    const root = document.getElementById(OVERLAY_ID);
    const space = currentSpace();
    const resource = dnaResource(space.id);
    if (space.frozen) { setStatus("当前风格记忆已冻结。", "error"); return; }
    const targetKey = root.querySelector("[data-sw-dna-target]").value;
    const targets = dnaTargets(resource.documents);
    const targetLabel = targets.find(item => item.key === targetKey)?.label || "我的作品";
    const matched = resource.documents.filter(document => dnaTargetKey(document) === targetKey);
    if (matched.length < DNA_MINIMUM_COUNT) { setStatus(`至少需要 ${DNA_MINIMUM_COUNT} 篇同一对象的完整文章。`, "error"); return; }
    const sourceDocuments = matched.slice(0, 24);
    const corpus = corpusForModel(sourceDocuments);
    const button = root.querySelector("[data-sw-dna-distill]");
    setBusy(button, true);
    resource.draft = {
      schemaVersion: 1,
      targetKey,
      targetLabel,
      sourceIds: sourceDocuments.map(document => document.id),
      sourceCount: sourceDocuments.length,
      createdAt: new Date().toISOString(),
      layers: { language: "", structure: "", cognitive: "", visual: "", summary: "" }
    };
    try {
      setStatus("Writing DNA 1/5：分析语言与句子节奏…", "busy");
      resource.draft.layers.language = await callWriter(corpus, "基于全部语料蒸馏 L1 语言 DNA。统计并归纳高频词、动词、句长分布、短长句比例、段落句数、标点、修辞、口语与书面语、中英文混用、常用和禁用表达。给出可执行规则及证据范围；不要摘要文章内容，不要复制原句，不要把主题事实当风格。输出中文 Markdown。");
      await saveDnaDraft(space, resource);

      setStatus("Writing DNA 2/5：提炼文章结构模板…", "busy");
      resource.draft.layers.structure = await callWriter(corpus, "基于全部语料蒸馏 L2 文章结构。识别开头 hook、核心问题进入方式、正文组织、转折、段落节奏和结尾收束；按内容类型给出至少 3 套可复用结构模板。只学习结构，不搬运观点或事实。输出中文 Markdown。");
      await saveDnaDraft(space, resource);

      setStatus("Writing DNA 3/5：归纳选题、素材与认知框架…", "busy");
      resource.draft.layers.cognitive = await callWriter(corpus, "基于全部语料蒸馏 L3-L5：选题逻辑、切入时机和角度、不会写的主题；素材来源偏好、数据和案例使用方式、争议信息边界；稳定的价值判断、核心假设和反复命题。必须区分有多篇证据支持的稳定规律与不确定推测，不把某篇文章的具体主张当成作者永久立场。输出中文 Markdown。");
      await saveDnaDraft(space, resource);

      setStatus("Writing DNA 4/5：分析视觉与排版线索…", "busy");
      resource.draft.layers.visual = await callWriter(corpus, "蒸馏 L6 视觉与排版风格。根据 Markdown 中可见的小标题、列表、加粗、引用、图片标记和段落留白，分析层级、密度、图文节奏和图片可能承担的功能。看不到图片内容时必须明确写‘未提供图片内容，无法判断’，禁止猜测颜色、字体或图片类型。输出可执行的中文 Markdown 指南。");
      await saveDnaDraft(space, resource);

      setStatus("Writing DNA 5/5：整合为可执行 DNA…", "busy");
      const layers = resource.draft.layers;
      const synthesisInput = `【L1 语言 DNA】\n${layers.language}\n\n【L2 结构模板】\n${layers.structure}\n\n【L3-L5 认知框架】\n${layers.cognitive}\n\n【L6 视觉风格】\n${layers.visual}`;
      resource.draft.layers.summary = await callWriter(synthesisInput, "将四份分层产物整合为一份不超过 4000 字、可直接用于写作的 Writing-DNA.md。保留明确规则、适用条件、冲突优先级和禁止项；删除重复与空泛描述。必须写明：用户本次指令 > 匹配体裁的结构模板 > 语言与视觉风格 > 认知框架；复刻写法，不复制原文事实、观点和句子。只输出 Markdown。");
      await saveDnaDraft(space, resource);
      recordEvent(space, "dna.candidate", `从 ${sourceDocuments.length} 篇“${targetLabel}”语料生成 DNA 候选`);
      queueSave(0);
      setStatus("六层蒸馏完成，请逐项审核后启用", "success");
      root.querySelector("[data-sw-dna-editor]")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      setStatus(`蒸馏中断：${error.message}；已完成层级已保存`, "error");
    } finally {
      setBusy(button, false);
    }
  }

  function syncDnaCandidateFromView() {
    const root = document.getElementById(OVERLAY_ID);
    const resource = dnaResource(currentSpace().id);
    if (!root || !resource.draft) return;
    for (const key of ["language", "structure", "cognitive", "visual", "summary"]) {
      resource.draft.layers[key] = root.querySelector(`[data-sw-dna-layer="${key}"]`).value.trim();
    }
  }

  async function activateDnaCandidate() {
    const root = document.getElementById(OVERLAY_ID);
    const space = currentSpace();
    const resource = dnaResource(space.id);
    if (space.frozen) { setStatus("当前风格记忆已冻结。", "error"); return; }
    if (!resource.draft) { setStatus("当前没有 DNA 候选。", "error"); return; }
    if (!root.querySelector("[data-sw-dna-approve]").checked) { setStatus("请先确认你已审核这组 DNA。", "error"); return; }
    syncDnaCandidateFromView();
    if (Object.values(resource.draft.layers).some(value => !String(value).trim())) { setStatus("五份 DNA 产物都需要有内容。", "error"); return; }
    const nextVersion = Math.max(Number(space.dna.activeVersion || 0), ...resource.versions.map(item => Number(item.version || 0))) + 1;
    const profile = {
      ...resource.draft,
      status: "active",
      version: nextVersion,
      approvedAt: new Date().toISOString()
    };
    try {
      const base = dnaBasePath(space.id);
      await writeJsonFile(`${base}/profile.json`, profile);
      await writeJsonFile(`${base}/versions/v${nextVersion}-${Date.now()}.json`, profile);
      await requestHost("file.delete", { path: `${base}/draft.json` });
      resource.profile = profile;
      resource.versions.unshift(profile);
      resource.draft = null;
      space.dna = { activeVersion: nextVersion, sourceCount: profile.sourceCount, targetLabel: profile.targetLabel, updatedAt: profile.approvedAt };
      space.memoryVersion += 1;
      recordEvent(space, "dna.activated", `启用 Writing DNA v${nextVersion}（${profile.targetLabel}）`);
      await saveState();
      renderWorkspace();
      setStatus(`Writing DNA v${nextVersion} 已启用`, "success");
    } catch (error) {
      setStatus(error.message, "error");
    }
  }

  async function discardDnaCandidate() {
    const space = currentSpace();
    const resource = dnaResource(space.id);
    resource.draft = null;
    try { await requestHost("file.delete", { path: `${dnaBasePath(space.id)}/draft.json` }); } catch { /* nothing to remove */ }
    recordEvent(space, "dna.rejected", "放弃 Writing DNA 候选");
    queueSave(0);
    renderDnaView();
  }

  function loadDnaVersionForReview(version) {
    const resource = dnaResource(currentSpace().id);
    resource.draft = {
      ...JSON.parse(JSON.stringify(version)),
      status: "draft",
      basedOnVersion: version.version,
      createdAt: new Date().toISOString()
    };
    renderDnaView();
    document.querySelector(`#${OVERLAY_ID} [data-sw-dna-editor]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setStatus(`已载入 v${version.version}，修改并确认后会保存为新版本`, "success");
  }

  function renderEvents(root, space) {
    const list = root.querySelector("[data-sw-events]");
    if (!space.events.length) {
      const empty = document.createElement("div");
      empty.className = "sw-empty";
      empty.textContent = "还没有写作事件。生成、导入或确认风格后会显示在这里。";
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(...space.events.slice(0, 20).map(event => {
      const row = document.createElement("div");
      row.className = "sw-event";
      const code = document.createElement("code");
      code.textContent = event.type;
      const summary = document.createElement("span");
      summary.textContent = event.summary;
      const time = document.createElement("time");
      time.textContent = new Date(event.at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
      row.append(code, summary, time);
      return row;
    }));
  }

  function syncVisibleValues() {
    const root = document.getElementById(OVERLAY_ID);
    if (!root) return;
    const space = currentSpace();
    space.brief = root.querySelector("[data-sw-brief]").value;
    space.material = root.querySelector("[data-sw-material]").value;
    space.template = root.querySelector("[data-sw-template]").value;
    space.styleRules = root.querySelector("[data-sw-rules]").value;
    space.draft = root.querySelector("[data-sw-draft]").value;
  }

  function sampleContext(space) {
    return space.samples.slice(0, 2).map((sample, index) => `【本人样本 ${index + 1}】\n${sample.text.slice(0, 2600)}`).join("\n\n");
  }

  function relevanceTokens(text) {
    return new Set((String(text || "").toLowerCase().match(/[\p{Script=Han}]{2,4}|[a-z0-9]{2,}/gu) || []).slice(0, 300));
  }

  function relatedDnaDocuments(profile, documents, query) {
    const allowed = new Set(profile.sourceIds || []);
    const candidates = documents.filter(document => allowed.has(document.id));
    const tokens = relevanceTokens(query);
    return candidates.map(document => {
      const haystack = `${document.title || ""} ${document.tags || ""} ${String(document.text || "").slice(0, 5000)}`.toLowerCase();
      let score = 0;
      for (const token of tokens) if (haystack.includes(token)) score += token.length;
      return { document, score };
    }).sort((a, b) => b.score - a.score || String(b.document.createdAt || "").localeCompare(String(a.document.createdAt || ""))).slice(0, 5).map(item => item.document);
  }

  async function buildDnaContext(space) {
    const resource = await loadDnaResources(space.id).catch(() => null);
    const profile = resource?.profile;
    if (!profile?.layers) return "";
    const query = `${space.brief}\n${space.material}`;
    const related = relatedDnaDocuments(profile, resource.documents, query);
    const rawContext = related.map((document, index) => `【语感校准原文 ${index + 1}：${document.title}】\n${String(document.text || "").slice(0, 12000)}`).join("\n\n");
    return [
      `【已启用 Writing DNA v${profile.version}：${profile.targetLabel}】`,
      `【L1 语言 DNA】\n${profile.layers.language}`,
      `【L2 文章结构模板】\n${profile.layers.structure}`,
      `【L3-L5 写作视角与认知框架】\n${profile.layers.cognitive}`,
      `【L6 视觉风格指南】\n${profile.layers.visual}`,
      `【Writing-DNA.md】\n${profile.layers.summary}`,
      rawContext ? `【与本次任务最相关的 ${related.length} 篇原文，仅校准语感】\n${rawContext}` : "",
      "规则冲突优先级：用户本次明确指令 > 匹配体裁的结构模板 > 语言特征与视觉风格 > 认知框架。只复刻写法，不得复制原文句子、事实、观点、人物或数据。"
    ].filter(Boolean).join("\n\n");
  }

  async function callWriter(selectedText, instruction) {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selected_text: selectedText, instruction, mode: "rewrite", tools: [] })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || `模型请求失败（${response.status}）`);
    if (!payload.edited_text) throw new Error("模型没有返回正文。");
    return payload.edited_text.trim();
  }

  async function generateDraft(polish) {
    const root = document.getElementById(OVERLAY_ID);
    syncVisibleValues();
    const space = currentSpace();
    if (polish && !space.draft.trim()) { setStatus("请先生成或输入一份正文。", "error"); return; }
    if (!polish && !space.brief.trim()) { setStatus("请先填写写作任务。", "error"); return; }
    const button = root.querySelector(polish ? "[data-sw-polish]" : "[data-sw-generate]");
    setBusy(button, true);
    setStatus(polish ? "正在按当前风格润色…" : "正在按当前风格创作…", "busy");
    try {
      const samples = sampleContext(space);
      const dnaContext = await buildDnaContext(space);
      const instruction = [
        `你正在 DeepTutor 的“${space.name}”隔离写作空间中工作。`,
        polish ? "请按下列约束润色正文，保持事实与核心含义；只输出润色后的完整正文。" : "请依据任务与材料创作一篇完整正文；不要复述任务说明，只输出正文。",
        `【模板约束】\n${space.template}`,
        `【稳定风格记忆】\n${space.styleRules}`,
        samples ? `【用户本人写作样本，仅学习表达方式，不复制事实】\n${samples}` : "【用户本人样本】暂无，仅遵循明确规则。",
        dnaContext || "【Writing DNA】当前空间尚未启用，忽略此层。",
        "不得编造用户没有提供的事实、数据或参考文献。"
      ].join("\n\n");
      const selectedText = polish
        ? space.draft
        : `【写作任务】\n${space.brief}\n\n【已有材料】\n${space.material || "无"}`;
      const result = await callWriter(selectedText, instruction);
      space.previousDraft = space.draft;
      space.draft = result;
      space.userEdited = false;
      root.querySelector("[data-sw-final-confirm]").checked = false;
      recordEvent(space, polish ? "draft.polished" : "draft.generated", `${space.name}生成 ${result.length} 字`);
      await saveState();
      renderWorkspace();
      setStatus("生成完成，尚未进入风格记忆", "success");
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      setBusy(button, false);
    }
  }

  function updateOriginLabel() {
    const root = document.getElementById(OVERLAY_ID);
    if (!root) return;
    const space = currentSpace();
    root.querySelector("[data-sw-origin]").textContent = !space.draft ? "尚未生成" : space.userEdited ? "已由你修改 · 未学习" : "AI 生成 · 未学习";
  }

  async function copyDraft() {
    const draft = currentSpace().draft;
    if (!draft.trim()) { setStatus("当前没有可复制的正文。", "error"); return; }
    try { await navigator.clipboard.writeText(draft); setStatus("正文已复制", "success"); }
    catch { setStatus("复制失败，请手动选择正文。", "error"); }
  }

  function undoDraft() {
    const space = currentSpace();
    if (!space.previousDraft) { setStatus("没有可撤回的上一版本。", "error"); return; }
    const current = space.draft;
    space.draft = space.previousDraft;
    space.previousDraft = current;
    space.userEdited = true;
    recordEvent(space, "draft.undo", "恢复上一版正文");
    queueSave(0);
    renderWorkspace();
  }

  async function cleanAiTone() {
    const root = document.getElementById(OVERLAY_ID);
    syncVisibleValues();
    const space = currentSpace();
    if (!space.draft.trim()) { setStatus("当前没有可检查的正文。", "error"); return; }
    const button = root.querySelector("[data-sw-less-ai]");
    setBusy(button, true);
    setStatus("正在按白名单规则检查 AI 痕迹…", "busy");
    try {
      const resource = await loadDnaResources(space.id).catch(() => null);
      const languageDna = resource?.profile?.layers?.language || space.styleRules;
      const instruction = [
        "对正文执行最后一道‘去 AI 味’检查。只输出修改后的完整正文，不解释修改。",
        `【当前空间语言 DNA，发生冲突时优先】\n${languageDna}`,
        `【白名单规则】\n- ${LESS_AI_TONE_RULES}`,
        "再次强调：信息守恒，不得添加或删除任何事实、数字、日期、人物、来源、因果、限定词和观点；没有明确命中规则的句子逐字保留。"
      ].join("\n\n");
      const result = await callWriter(space.draft, instruction);
      space.previousDraft = space.draft;
      space.draft = result;
      space.userEdited = false;
      recordEvent(space, "draft.less-ai-tone", `按 Writing DNA 与白名单规则检查 ${result.length} 字`);
      await saveState();
      renderWorkspace();
      setStatus("AI 痕迹检查完成，可用“撤回”恢复上一版", "success");
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      setBusy(button, false);
    }
  }

  function saveRules() {
    const root = document.getElementById(OVERLAY_ID);
    const space = currentSpace();
    if (space.frozen) { setStatus("当前风格记忆已冻结。", "error"); return; }
    space.styleRules = root.querySelector("[data-sw-rules]").value.trim();
    space.template = root.querySelector("[data-sw-template]").value.trim();
    space.memoryVersion += 1;
    recordEvent(space, "memory.manual", `手动更新风格规则至 v${space.memoryVersion}`);
    queueSave(0);
    renderWorkspace();
  }

  async function analyzeFinalDraft() {
    const root = document.getElementById(OVERLAY_ID);
    syncVisibleValues();
    const space = currentSpace();
    if (space.frozen) { setStatus("当前风格记忆已冻结。", "error"); return; }
    if (!root.querySelector("[data-sw-final-confirm]").checked) { setStatus("请先确认这是你认可的定稿。", "error"); return; }
    if (space.draft.trim().length < 120) { setStatus("定稿太短，至少需要 120 字。", "error"); return; }
    const button = root.querySelector("[data-sw-learn]");
    setBusy(button, true);
    setStatus("正在提炼候选风格，不会自动写入…", "busy");
    try {
      const instruction = "分析这篇由用户确认的定稿，只提炼可复用的写作风格，不记录文章中的人物、事实、研究结论或主题内容。输出 5—8 条具体规则，每条以短横线开头，重点覆盖语气、句式、结构、用词、节奏和应避免的表达。只输出规则。";
      space.pendingCandidate = await callWriter(space.draft, instruction);
      recordEvent(space, "style.candidate", "从确认定稿生成候选风格规律");
      await saveState();
      renderWorkspace();
      setStatus("候选规律已生成，等待你确认", "success");
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      setBusy(button, false);
    }
  }

  function acceptCandidate() {
    const root = document.getElementById(OVERLAY_ID);
    const space = currentSpace();
    if (space.frozen) { setStatus("当前风格记忆已冻结。", "error"); return; }
    const candidate = root.querySelector("[data-sw-candidate]").value.trim();
    if (!candidate) { setStatus("候选风格为空。", "error"); return; }
    space.styleRules = `${space.styleRules.trim()}\n${candidate}`.trim();
    space.pendingCandidate = "";
    space.memoryVersion += 1;
    recordEvent(space, "style.approved", `批准候选规律并更新至 v${space.memoryVersion}`);
    queueSave(0);
    renderWorkspace();
  }

  function discardCandidate() {
    const space = currentSpace();
    space.pendingCandidate = "";
    recordEvent(space, "style.rejected", "放弃候选风格规律");
    queueSave(0);
    renderWorkspace();
  }

  function addSample() {
    const root = document.getElementById(OVERLAY_ID);
    const space = currentSpace();
    const input = root.querySelector("[data-sw-sample-input]");
    const text = input.value.trim();
    if (!root.querySelector("[data-sw-sample-confirm]").checked) { setStatus("请先确认样本来源。", "error"); return; }
    if (text.length < 80) { setStatus("样本太短，至少需要 80 字。", "error"); return; }
    space.samples.unshift({ id: crypto.randomUUID?.() || `${Date.now()}`, text: text.slice(0, 20000), createdAt: new Date().toISOString() });
    space.samples = space.samples.slice(0, 30);
    recordEvent(space, "sample.added", `加入本人样本 ${Math.min(text.length, 20000)} 字`);
    input.value = "";
    root.querySelector("[data-sw-sample-confirm]").checked = false;
    queueSave(0);
    renderWorkspace();
  }

  function normalizeReferenceUrl(value) {
    const trimmed = value.trim();
    if (!trimmed) return "";
    try {
      const url = new URL(trimmed);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href.slice(0, 500) : null;
    } catch {
      return null;
    }
  }

  function addReference() {
    const root = document.getElementById(OVERLAY_ID);
    const space = currentSpace();
    const textInput = root.querySelector("[data-sw-reference-text]");
    const text = textInput.value.trim();
    if (!root.querySelector("[data-sw-reference-confirm]").checked) { setStatus("请先确认案例用途与来源。", "error"); return; }
    if (text.length < 80) { setStatus("案例太短，至少需要 80 字。", "error"); return; }
    const url = normalizeReferenceUrl(root.querySelector("[data-sw-reference-url]").value);
    if (url === null) { setStatus("来源链接需要以 http:// 或 https:// 开头。", "error"); return; }
    if (space.references.length >= 20) { setStatus("当前空间最多保存 20 个案例，请先移除不再需要的案例。", "error"); return; }
    const titleInput = root.querySelector("[data-sw-reference-title]");
    const tagsInput = root.querySelector("[data-sw-reference-tags]");
    const reference = {
      id: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      title: titleInput.value.trim().slice(0, 100) || `参考案例 ${space.references.length + 1}`,
      url,
      tags: tagsInput.value.trim().slice(0, 120),
      text: text.slice(0, 12000),
      createdAt: new Date().toISOString()
    };
    space.references.unshift(reference);
    recordEvent(space, "reference.added", `保存参考案例“${reference.title}”`);
    titleInput.value = "";
    root.querySelector("[data-sw-reference-url]").value = "";
    tagsInput.value = "";
    textInput.value = "";
    root.querySelector("[data-sw-reference-confirm]").checked = false;
    queueSave(0);
    renderWorkspace();
    setStatus("案例已保存，但未进入个人风格记忆", "success");
  }

  function removeReference(id) {
    const space = currentSpace();
    const reference = space.references.find(item => item.id === id);
    if (!reference || !window.confirm(`移除参考案例“${reference.title}”吗？`)) return;
    space.references = space.references.filter(item => item.id !== id);
    recordEvent(space, "reference.removed", `移除参考案例“${reference.title}”`);
    queueSave(0);
    renderWorkspace();
  }

  async function extractTemplateCandidate() {
    const root = document.getElementById(OVERLAY_ID);
    const space = currentSpace();
    if (!space.references.length) { setStatus("请先保存至少一个参考案例。", "error"); return; }
    if (space.frozen) { setStatus("当前风格记忆已冻结。", "error"); return; }
    const button = root.querySelector("[data-sw-extract-template]");
    setBusy(button, true);
    setStatus("正在分析案例结构，不会直接改写模板…", "busy");
    try {
      const referenceContext = space.references.slice(0, 5).map((item, index) => [
        `【参考案例 ${index + 1}：${item.title}】`,
        item.tags ? `标签：${item.tags}` : "",
        item.text.slice(0, 4000)
      ].filter(Boolean).join("\n")).join("\n\n");
      const instruction = [
        `这些文字是“${space.name}”空间的外部参考案例，不是用户本人风格。`,
        "只分析它们可复用的内容结构、标题模式、开头方式、信息密度、段落节奏、列表组织和结尾方式。",
        "不要复制或改写任何原句，不要记录品牌、人名、账号、具体事实、个人经历、价格或观点。",
        "输出一份可直接作为写作约束的通用中文模板，使用占位符说明应填写的内容，并补充防止夸张、虚构和照抄的边界。只输出模板。"
      ].join("\n");
      space.pendingTemplateCandidate = await callWriter(referenceContext, instruction);
      recordEvent(space, "template.candidate", `从 ${Math.min(space.references.length, 5)} 个参考案例生成模板候选`);
      await saveState();
      renderWorkspace();
      setStatus("模板候选已生成，等待你手动应用", "success");
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      setBusy(button, false);
    }
  }

  function applyTemplateCandidate() {
    const root = document.getElementById(OVERLAY_ID);
    const space = currentSpace();
    if (space.frozen) { setStatus("当前风格记忆已冻结。", "error"); return; }
    const candidate = root.querySelector("[data-sw-template-candidate]").value.trim();
    if (!candidate) { setStatus("模板候选为空。", "error"); return; }
    space.template = candidate;
    space.pendingTemplateCandidate = "";
    space.memoryVersion += 1;
    recordEvent(space, "template.approved", `应用案例模板并更新至 v${space.memoryVersion}`);
    queueSave(0);
    renderWorkspace();
    setStatus("模板已应用；案例原文仍未进入生成上下文", "success");
  }

  function discardTemplateCandidate() {
    const space = currentSpace();
    space.pendingTemplateCandidate = "";
    recordEvent(space, "template.rejected", "放弃案例模板候选");
    queueSave(0);
    renderWorkspace();
  }

  function setBusy(button, busy) {
    if (!button) return;
    button.disabled = busy;
    button.classList.toggle("sw-busy", busy);
  }

  function setStatus(message, kind = "") {
    const status = document.querySelector(`#${OVERLAY_ID} [data-sw-status]`);
    if (!status) return;
    status.textContent = message;
    status.dataset.kind = kind;
  }

  const observer = new MutationObserver(() => window.requestAnimationFrame(ensureEntry));
  function startObserver() {
    if (!document.documentElement) {
      window.setTimeout(startObserver, 0);
      return;
    }
    observer.observe(document.documentElement, { childList: true, subtree: true });
    ensureEntry();
  }
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      window.setTimeout(ensureEntry, 0);
      return result;
    };
  }
  window.addEventListener("popstate", ensureEntry);
  window.addEventListener("DOMContentLoaded", ensureEntry, { once: true });
  startObserver();
})();
