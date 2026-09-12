// Run: node tests/wrong-ai-prompt.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function check(file) {
    const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    function extract(start, end) {
        const from = html.indexOf(start), to = html.indexOf(end, from);
        assert.ok(from >= 0 && to > from, file + ': function markers');
        return html.slice(from, to);
    }
    const calls = [], messages = [];
    const input = { value: '' };
    const container = { querySelectorAll: () => messages };
    const elements = {
        chatInput: input, chatContainer: container,
        exerciseAskInput: { value: 'why?' }, exerciseDoingQuestion: { appendChild() {} }
    };
    let personaReads = 0;
    const sandbox = {
        window: {}, console, exerciseSelectedText: 'x + 1 = 2', exerciseSelectionRange: null,
        document: { getElementById: id => elements[id], createElement: () => ({}) },
        i18n: (key, ...args) => '[' + key + ']' + args.join('|'),
        getAIPersona: () => { personaReads++; return 'CUSTOM PERSONA'; },
        addChatMessage: (_, isUser, text) => messages.push({
            _rawChatText: text, classList: { contains: name => name === 'user' && isUser }
        }),
        addTypingIndicator() {}, removeTypingIndicator() {}, hideExerciseSelectionMenu() {},
        showToast() {}, renderChatMarkdownLatex: text => text, renderLectureMath() {},
        callAI: async (prompt, history) => {
            calls.push({ prompt, history: JSON.parse(JSON.stringify(history)) });
            return 'AI answer';
        }
    };
    vm.createContext(sandbox);
    vm.runInContext(
        extract('        async function askAIAboutExerciseSelection()', '        function openBookFromLecture()')
        + extract('        async function sendAIChat()', '        // ==================== Notification Helper'), sandbox);

    await sandbox.askAIAboutExerciseSelection();
    const selectedPrompt = calls[0].prompt;
    assert.equal(selectedPrompt, sandbox.i18n('prompt_math_explain'));
    assert.equal(personaReads, 0);

    Object.assign(sandbox.window, {
        _wrongAIChatOverride: true, _wrongAIContext: 'Original question and handwritten answer',
        _wrongAIImages: [{ qIndex: 2, page: 2, pages: 3, drawing: 'data:image/png;base64,example' }]
    });
    input.value = 'Explain my mistake';
    await sandbox.sendAIChat();
    const wrongPrompt = selectedPrompt + sandbox.i18n('prompt_wrong_context') + sandbox.window._wrongAIContext;
    assert.equal(calls[1].prompt, wrongPrompt, file + ': first wrong-question prompt');
    assert.equal(personaReads, 0, file + ': wrong questions must not read the persona');
    assert.deepEqual(calls[1].history[0].content, [
        { type: 'text', text: sandbox.i18n('prompt_wrong_image_label', 3, 2, 3) },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,example' } },
        { type: 'text', text: sandbox.i18n('prompt_wrong_images_user', 'Explain my mistake') }
    ]);
    assert.equal(sandbox.window._wrongAIImages.length, 0);

    input.value = 'Explain the next step';
    await sandbox.sendAIChat();
    assert.equal(calls[2].prompt, wrongPrompt, file + ': follow-up wrong-question prompt');
    assert.equal(personaReads, 0, file + ': follow-ups must not read the persona');
    assert.deepEqual(calls[2].history, [
        { role: 'user', content: 'Explain my mistake' },
        { role: 'assistant', content: 'AI answer' },
        { role: 'user', content: 'Explain the next step' }
    ]);

    sandbox.window._wrongAIChatOverride = false;
    messages.length = 0;
    input.value = 'Give me advice';
    await sandbox.sendAIChat();
    assert.equal(calls[3].prompt, 'CUSTOM PERSONA\n\n' + sandbox.i18n('prompt_chat_base'));
    assert.equal(personaReads, 1, file + ': ordinary chat keeps its persona');
    assert.deepEqual(calls[3].history, [{ role: 'user', content: 'Give me advice' }]);
}

(async () => {
    for (const file of ['docs/index.html', 'app/src/main/assets/www/index.html']) await check(file);
    console.log('Wrong-question AI prompt checks passed (web and Android).');
})().catch(err => { console.error(err); process.exitCode = 1; });
