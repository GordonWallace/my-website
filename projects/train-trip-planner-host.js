const HEIGHT_MESSAGE_TYPE = 'train-trip-planner:height';

function escapeAttribute(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function rewriteTemplate(template, { styleUrl, scriptUrl, bridgeUrl, baseHref }) {
    const baseTag = `<base href="${escapeAttribute(baseHref)}">`;

    let rewritten = template.replace(/<head>/i, `<head>\n    ${baseTag}`);
    rewritten = rewritten.replace(/{{\s*url_for\('static',\s*filename='style\.css'\)\s*}}/g, styleUrl);
    rewritten = rewritten.replace(
        /<script\s+src="{{\s*url_for\('static',\s*filename='script\.js'\)\s*}}"><\/script>/i,
        `    <script src="${bridgeUrl}"><\/script>\n    <script src="${scriptUrl}"><\/script>`
    );

    if (!rewritten.includes(bridgeUrl)) {
        rewritten = rewritten.replace(/<\/body>/i, `    <script src="${bridgeUrl}"><\/script>\n    <script src="${scriptUrl}"><\/script>\n</body>`);
    }

    return rewritten;
}

function setStatus(message, isError = false) {
    const status = document.getElementById('planner-host-status');
    status.textContent = message;
    status.classList.toggle('error', isError);
}

document.addEventListener('DOMContentLoaded', async () => {
    const frame = document.getElementById('planner-frame');
    const baseHref = new URL('./', window.location.href).href;
    const templateUrl = new URL('../train-trip-planner/templates/index.html', window.location.href).href;
    const styleUrl = new URL('../train-trip-planner/static/style.css', window.location.href).href;
    const scriptUrl = new URL('../train-trip-planner/static/script.js', window.location.href).href;
    const bridgeUrl = new URL('./train-trip-planner-bridge.js', window.location.href).href;

    window.addEventListener('message', (event) => {
        if (event.source !== frame.contentWindow) {
            return;
        }
        if (!event.data || event.data.type !== HEIGHT_MESSAGE_TYPE) {
            return;
        }
        const nextHeight = Number(event.data.height);
        if (Number.isFinite(nextHeight) && nextHeight > 0) {
            frame.style.height = `${Math.max(nextHeight + 24, 1200)}px`;
        }
    });

    try {
        const response = await fetch(templateUrl, { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`Failed to load upstream template (${response.status})`);
        }

        const template = await response.text();
        frame.srcdoc = rewriteTemplate(template, { styleUrl, scriptUrl, bridgeUrl, baseHref });
        setStatus('The planner is being served from the checked-in submodule assets.');
    } catch (error) {
        console.error(error);
        setStatus('Unable to load the planner from the submodule right now.', true);
    }
});
