import "./style.css";

type SlidePage = {
  id: string;
  title: string;
  text: string;
  duration: number;
  backgroundUrl: string;
  foregroundUrl: string;
  voiceUrl: string;
  voiceDuration: number;
};

type ResolutionPreset = {
  label: string;
  width: number;
  height: number;
};

type QualityPreset = {
  label: string;
  videoBitsPerSecond: number;
};

type SavedPresentation = {
  app: "presentation-video-generator";
  version: 1;
  resolutionIndex: number;
  qualityIndex: number;
  pages: Array<{
    title: string;
    text: string;
    duration: number;
    backgroundUrl: string;
    foregroundUrl: string;
    voiceUrl: string;
    voiceDuration: number;
  }>;
};

const resolutions: ResolutionPreset[] = [
  { label: "480p", width: 854, height: 480 },
  { label: "720p", width: 1280, height: 720 },
  { label: "1080p", width: 1920, height: 1080 },
];

const qualities: QualityPreset[] = [
  { label: "Legere", videoBitsPerSecond: 1_500_000 },
  { label: "Standard", videoBitsPerSecond: 3_500_000 },
  { label: "Haute", videoBitsPerSecond: 7_000_000 },
];

const MIN_PAGE_DURATION_SECONDS = 0.5;
const DEFAULT_PAGE_DURATION_SECONDS = 4;

const state = {
  pages: [createPage(1)],
  selectedPageId: "",
  resolutionIndex: 1,
  qualityIndex: 1,
  isRecording: false,
  recorder: null as MediaRecorder | null,
  recordedChunks: [] as Blob[],
  recordedStream: null as MediaStream | null,
  isRendering: false,
  renderProgress: "",
  videoUrl: "",
  videoSize: 0,
};

state.selectedPageId = state.pages[0].id;

function createPage(position: number): SlidePage {
  return {
    id: crypto.randomUUID(),
    title: `Page ${position}`,
    text: "Votre texte de presentation",
    duration: DEFAULT_PAGE_DURATION_SECONDS,
    backgroundUrl: "",
    foregroundUrl: "",
    voiceUrl: "",
    voiceDuration: 0,
  };
}

function getAppRoot(): HTMLElement {
  const existing = document.querySelector<HTMLElement>("#app");

  if (existing) {
    return existing;
  }

  const created = document.createElement("div");
  created.id = "app";
  document.body.appendChild(created);
  return created;
}

function selectedPage(): SlidePage {
  return state.pages.find((page) => page.id === state.selectedPageId) ?? state.pages[0];
}

function effectiveDuration(page: SlidePage): number {
  const duration = page.voiceUrl ? page.voiceDuration : page.duration;
  return normalizeDuration(duration);
}

function normalizeDuration(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) {
    return DEFAULT_PAGE_DURATION_SECONDS;
  }

  return Math.max(duration, MIN_PAGE_DURATION_SECONDS);
}

function render(): void {
  const app = getAppRoot();
  const page = selectedPage();
  const totalDuration = state.pages.reduce((sum, item) => sum + effectiveDuration(item), 0);

  app.innerHTML = `
    <main class="app-shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">Presentation Video Generator</p>
          <h1>Generateur de videos de presentation</h1>
        </div>
        <div class="top-actions">
          <button id="savePresentation" type="button">Enregistrer presentation</button>
          <label class="load-button" for="loadPresentationInput">Charger presentation</label>
          <input id="loadPresentationInput" class="hidden-file" type="file" accept="application/json,.json" />
          <button class="primary-action" id="generateVideo" type="button" ${state.isRendering ? "disabled" : ""}>
            Generer la video
          </button>
        </div>
      </header>

      <section class="workspace">
        <aside class="page-panel" aria-label="Pages">
          <div class="panel-head">
            <h2>Pages</h2>
            <button id="addPage" type="button">Creer page</button>
          </div>
          <div class="page-list">
            ${state.pages.map((item, index) => pageButtonTemplate(item, index)).join("")}
          </div>
          <div class="page-tools">
            <button id="moveUp" type="button" ${state.pages.indexOf(page) === 0 ? "disabled" : ""}>Haut</button>
            <button id="moveDown" type="button" ${state.pages.indexOf(page) === state.pages.length - 1 ? "disabled" : ""}>Bas</button>
            <button id="deletePage" class="danger" type="button" ${state.pages.length === 1 ? "disabled" : ""}>Supprimer</button>
          </div>
        </aside>

        <section class="preview-column">
          <div class="preview-frame" id="previewFrame">
            ${slidePreviewTemplate(page)}
          </div>
          <div class="timeline">
            <span>${state.pages.length} page${state.pages.length > 1 ? "s" : ""}</span>
            <span>Duree totale ${formatSeconds(totalDuration)}</span>
            <span>${resolutions[state.resolutionIndex].label} / ${qualities[state.qualityIndex].label}</span>
          </div>
        </section>

        <aside class="editor-panel" aria-label="Edition">
          <h2>Edition de la page</h2>

          <label>
            Texte
            <textarea id="pageText" rows="7">${escapeHtml(page.text)}</textarea>
          </label>

          <div class="file-grid">
            <label>
              Image de fond
              <input id="backgroundInput" type="file" accept="image/*" />
            </label>
            <label>
              Image a droite
              <input id="foregroundInput" type="file" accept="image/*" />
            </label>
          </div>

          <div class="clear-tools">
            <button id="clearBackground" type="button" ${page.backgroundUrl ? "" : "disabled"}>Retirer le fond</button>
            <button id="clearForeground" type="button" ${page.foregroundUrl ? "" : "disabled"}>Retirer l'image</button>
          </div>

          <section class="voice-box">
            <div>
              <h3>Voix de la page</h3>
              <p>${page.voiceUrl ? `Piste vocale: ${formatSeconds(page.voiceDuration)}` : "Aucune voix enregistree"}</p>
            </div>
            <div class="voice-actions">
              <button id="recordVoice" type="button">${state.isRecording ? "Arreter" : "Enregistrer"}</button>
              <button id="clearVoice" type="button" ${page.voiceUrl || state.isRecording ? "" : "disabled"}>Effacer</button>
            </div>
            ${
              page.voiceUrl
                ? `<audio class="voice-player" src="${page.voiceUrl}" controls></audio>`
                : `<label class="duration-field">Duree sans voix (secondes)<input id="pageDuration" type="number" min="0.5" max="120" step="0.5" value="${page.duration}" /></label>`
            }
          </section>

          <section class="export-box">
            <h3>Export video</h3>
            <label>
              Resolution
              <select id="resolutionSelect">
                ${resolutions.map((item, index) => `<option value="${index}" ${index === state.resolutionIndex ? "selected" : ""}>${item.label} - ${item.width}x${item.height}</option>`).join("")}
              </select>
            </label>
            <label>
              Qualite
              <select id="qualitySelect">
                ${qualities.map((item, index) => `<option value="${index}" ${index === state.qualityIndex ? "selected" : ""}>${item.label}</option>`).join("")}
              </select>
            </label>
            <p class="status">${state.renderProgress}</p>
            ${state.videoUrl ? `<a class="download-link" href="${state.videoUrl}" download="presentation-video.webm" data-video-size="${state.videoSize}">Telecharger la video (${formatFileSize(state.videoSize)})</a>` : ""}
          </section>
        </aside>
      </section>
    </main>
  `;

  bindEvents();
}

function pageButtonTemplate(page: SlidePage, index: number): string {
  const selected = page.id === state.selectedPageId ? "is-selected" : "";
  return `
    <button class="page-card ${selected}" type="button" data-page-id="${page.id}">
      <span>${index + 1}</span>
      <strong>${escapeHtml(page.title)}</strong>
      <small>${formatSeconds(effectiveDuration(page))}</small>
    </button>
  `;
}

function slidePreviewTemplate(page: SlidePage): string {
  const backgroundStyle = page.backgroundUrl ? `style="background-image: url('${page.backgroundUrl}')"` : "";
  const bodyClass = page.foregroundUrl ? "has-visual" : "text-only";
  return `
    <div class="slide-preview ${page.backgroundUrl ? "has-background" : ""}" ${backgroundStyle}>
      <div class="slide-shade"></div>
      <div class="slide-content ${bodyClass}">
        <p class="slide-text">${escapeHtml(page.text)}</p>
        ${page.foregroundUrl ? `<img class="slide-visual" src="${page.foregroundUrl}" alt="" />` : ""}
      </div>
    </div>
  `;
}

function bindEvents(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-page-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedPageId = button.dataset.pageId ?? state.selectedPageId;
      render();
    });
  });

  document.querySelector<HTMLButtonElement>("#addPage")?.addEventListener("click", () => {
    const page = createPage(state.pages.length + 1);
    state.pages.push(page);
    state.selectedPageId = page.id;
    render();
  });

  document.querySelector<HTMLButtonElement>("#deletePage")?.addEventListener("click", () => {
    if (state.pages.length === 1) {
      return;
    }
    const index = state.pages.findIndex((item) => item.id === state.selectedPageId);
    state.pages.splice(index, 1);
    state.pages.forEach((item, itemIndex) => {
      item.title = `Page ${itemIndex + 1}`;
    });
    state.selectedPageId = state.pages[Math.max(0, index - 1)].id;
    render();
  });

  document.querySelector<HTMLButtonElement>("#moveUp")?.addEventListener("click", () => movePage(-1));
  document.querySelector<HTMLButtonElement>("#moveDown")?.addEventListener("click", () => movePage(1));

  document.querySelector<HTMLTextAreaElement>("#pageText")?.addEventListener("input", (event) => {
    selectedPage().text = (event.currentTarget as HTMLTextAreaElement).value;
    updatePreviewOnly();
  });

  document.querySelector<HTMLInputElement>("#pageDuration")?.addEventListener("input", (event) => {
    const input = event.currentTarget as HTMLInputElement;
    const value = input.valueAsNumber;
    selectedPage().duration = Number.isFinite(value) ? normalizeDuration(value) : selectedPage().duration;
  });

  document.querySelector<HTMLInputElement>("#backgroundInput")?.addEventListener("change", (event) => {
    void handleImageInput(event.currentTarget as HTMLInputElement, "backgroundUrl");
  });

  document.querySelector<HTMLInputElement>("#foregroundInput")?.addEventListener("change", (event) => {
    void handleImageInput(event.currentTarget as HTMLInputElement, "foregroundUrl");
  });

  document.querySelector<HTMLButtonElement>("#clearBackground")?.addEventListener("click", () => {
    selectedPage().backgroundUrl = "";
    render();
  });

  document.querySelector<HTMLButtonElement>("#clearForeground")?.addEventListener("click", () => {
    selectedPage().foregroundUrl = "";
    render();
  });

  document.querySelector<HTMLButtonElement>("#recordVoice")?.addEventListener("click", () => {
    void toggleRecording();
  });

  document.querySelector<HTMLButtonElement>("#clearVoice")?.addEventListener("click", () => {
    clearVoice();
  });

  document.querySelector<HTMLSelectElement>("#resolutionSelect")?.addEventListener("change", (event) => {
    state.resolutionIndex = Number((event.currentTarget as HTMLSelectElement).value);
  });

  document.querySelector<HTMLSelectElement>("#qualitySelect")?.addEventListener("change", (event) => {
    state.qualityIndex = Number((event.currentTarget as HTMLSelectElement).value);
  });

  document.querySelector<HTMLButtonElement>("#generateVideo")?.addEventListener("click", () => {
    void generateVideo();
  });

  document.querySelector<HTMLButtonElement>("#savePresentation")?.addEventListener("click", () => {
    void savePresentation();
  });

  document.querySelector<HTMLInputElement>("#loadPresentationInput")?.addEventListener("change", (event) => {
    void loadPresentation(event.currentTarget as HTMLInputElement);
  });
}

function updatePreviewOnly(): void {
  const frame = document.querySelector<HTMLElement>("#previewFrame");
  if (frame) {
    frame.innerHTML = slidePreviewTemplate(selectedPage());
  }
}

function movePage(direction: -1 | 1): void {
  const index = state.pages.findIndex((page) => page.id === state.selectedPageId);
  const nextIndex = index + direction;

  if (nextIndex < 0 || nextIndex >= state.pages.length) {
    return;
  }

  const [page] = state.pages.splice(index, 1);
  state.pages.splice(nextIndex, 0, page);
  state.pages.forEach((item, itemIndex) => {
    item.title = `Page ${itemIndex + 1}`;
  });
  render();
}

async function handleImageInput(input: HTMLInputElement, key: "backgroundUrl" | "foregroundUrl"): Promise<void> {
  const file = input.files?.[0];

  if (!file) {
    return;
  }

  selectedPage()[key] = URL.createObjectURL(file);
  render();
}

async function toggleRecording(): Promise<void> {
  if (state.isRecording) {
    state.recorder?.stop();
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    state.renderProgress = "Votre navigateur ne permet pas l'enregistrement audio.";
    render();
    return;
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  state.recordedStream = stream;
  state.recordedChunks = [];
  state.recorder = new MediaRecorder(stream);
  state.isRecording = true;

  state.recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) {
      state.recordedChunks.push(event.data);
    }
  });

  state.recorder.addEventListener("stop", () => {
    void saveRecording();
  });

  state.recorder.start();
  render();
}

async function saveRecording(): Promise<void> {
  state.recordedStream?.getTracks().forEach((track) => track.stop());
  const blob = new Blob(state.recordedChunks, { type: "audio/webm" });
  const url = URL.createObjectURL(blob);
  const page = selectedPage();
  page.voiceUrl = url;
  page.voiceDuration = await readMediaDuration(url);
  state.isRecording = false;
  state.recorder = null;
  state.recordedStream = null;
  render();
}

function clearVoice(): void {
  if (state.isRecording) {
    state.recorder?.stop();
    return;
  }
  const page = selectedPage();
  page.voiceUrl = "";
  page.voiceDuration = 0;
  render();
}

async function savePresentation(): Promise<void> {
  state.renderProgress = "Sauvegarde de la presentation...";
  render();

  try {
    const presentation: SavedPresentation = {
      app: "presentation-video-generator",
      version: 1,
      resolutionIndex: state.resolutionIndex,
      qualityIndex: state.qualityIndex,
      pages: await Promise.all(
        state.pages.map(async (page) => ({
          title: page.title,
          text: page.text,
          duration: normalizeDuration(page.duration),
          backgroundUrl: await urlToDataUrl(page.backgroundUrl),
          foregroundUrl: await urlToDataUrl(page.foregroundUrl),
          voiceUrl: await urlToDataUrl(page.voiceUrl),
          voiceDuration: page.voiceDuration,
        })),
      ),
    };
    const blob = new Blob([JSON.stringify(presentation, null, 2)], { type: "application/json" });
    downloadBlob(blob, `presentation-${new Date().toISOString().slice(0, 10)}.json`);
    state.renderProgress = "Presentation sauvegardee.";
  } catch {
    state.renderProgress = "Impossible de sauvegarder la presentation.";
  }

  render();
}

async function loadPresentation(input: HTMLInputElement): Promise<void> {
  const file = input.files?.[0];

  if (!file) {
    return;
  }

  state.renderProgress = "Chargement de la presentation...";
  render();

  try {
    const rawPresentation = JSON.parse(await file.text()) as Partial<SavedPresentation>;

    if (rawPresentation.app !== "presentation-video-generator" || !Array.isArray(rawPresentation.pages)) {
      throw new Error("Format invalide");
    }

    state.pages = rawPresentation.pages.map((page, index) => ({
      id: crypto.randomUUID(),
      title: `Page ${index + 1}`,
      text: typeof page.text === "string" ? page.text : "",
      duration: normalizeDuration(Number(page.duration)),
      backgroundUrl: typeof page.backgroundUrl === "string" ? page.backgroundUrl : "",
      foregroundUrl: typeof page.foregroundUrl === "string" ? page.foregroundUrl : "",
      voiceUrl: typeof page.voiceUrl === "string" ? page.voiceUrl : "",
      voiceDuration: normalizeDuration(Number(page.voiceDuration)),
    }));

    if (state.pages.length === 0) {
      state.pages = [createPage(1)];
    }

    state.selectedPageId = state.pages[0].id;
    state.resolutionIndex = clampIndex(Number(rawPresentation.resolutionIndex), resolutions.length, 1);
    state.qualityIndex = clampIndex(Number(rawPresentation.qualityIndex), qualities.length, 1);
    state.videoUrl = "";
    state.videoSize = 0;
    state.renderProgress = "Presentation chargee.";
  } catch {
    state.renderProgress = "Impossible de charger cette presentation.";
  }

  input.value = "";
  render();
}

async function generateVideo(): Promise<void> {
  if (state.isRendering) {
    return;
  }

  if (typeof MediaRecorder === "undefined") {
    state.renderProgress = "Votre navigateur ne permet pas l'export video.";
    render();
    return;
  }

  state.isRendering = true;
  state.videoUrl = "";
  state.videoSize = 0;
  state.renderProgress = "Preparation des images et de l'audio...";
  render();

  const resolution = resolutions[state.resolutionIndex];
  const quality = qualities[state.qualityIndex];
  const canvas = document.createElement("canvas");
  canvas.width = resolution.width;
  canvas.height = resolution.height;
  const context = canvas.getContext("2d");

  if (!context) {
    state.isRendering = false;
    state.renderProgress = "Canvas indisponible.";
    render();
    return;
  }

  const canvasStream = canvas.captureStream(0);
  const canvasVideoTrack = canvasStream.getVideoTracks()[0] as (MediaStreamTrack & { requestFrame?: () => void }) | undefined;
  const hasVoice = state.pages.some((page) => Boolean(page.voiceUrl));
  const audioContext = hasVoice ? new AudioContext() : null;
  const audioDestination = audioContext?.createMediaStreamDestination() ?? null;
  audioDestination?.stream.getAudioTracks().forEach((track) => canvasStream.addTrack(track));

  const mimeType = chooseMimeType();
  const recorderOptions: MediaRecorderOptions = {
    videoBitsPerSecond: quality.videoBitsPerSecond,
  };

  if (mimeType) {
    recorderOptions.mimeType = mimeType;
  }

  const recorder = new MediaRecorder(canvasStream, recorderOptions);
  const chunks: Blob[] = [];

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  });

  const finished = new Promise<Blob>((resolve) => {
    recorder.addEventListener("stop", () => {
      resolve(new Blob(chunks, { type: mimeType }));
    });
  });

  recorder.start(250);
  await wait(100);

  for (let index = 0; index < state.pages.length; index += 1) {
    const page = state.pages[index];
    state.renderProgress = `Rendu page ${index + 1} / ${state.pages.length}`;
    render();
    await drawPageForDuration(context, canvas, page, audioContext, audioDestination, canvasVideoTrack);
  }

  recorder.requestData();
  await wait(250);
  recorder.stop();
  const blob = await finished;
  await audioContext?.close();
  state.videoSize = blob.size;
  state.videoUrl = blob.size > 0 ? URL.createObjectURL(blob) : "";
  state.isRendering = false;
  state.renderProgress = blob.size > 0 ? "Video prete." : "La video generee est vide, relancez l'export.";
  render();
}

async function drawPageForDuration(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  page: SlidePage,
  audioContext: AudioContext | null,
  audioDestination: MediaStreamAudioDestinationNode | null,
  canvasVideoTrack: (MediaStreamTrack & { requestFrame?: () => void }) | undefined,
): Promise<void> {
  const background = page.backgroundUrl ? await loadImage(page.backgroundUrl) : null;
  const foreground = page.foregroundUrl ? await loadImage(page.foregroundUrl) : null;
  const duration = effectiveDuration(page);
  const startedAt = performance.now();
  const audio = page.voiceUrl && audioContext && audioDestination
    ? await createAudioElement(page.voiceUrl, audioContext, audioDestination)
    : null;

  audio?.play();

  await new Promise<void>((resolve) => {
    let frame = 0;

    const tick = (): void => {
      drawSlide(context, canvas, page, background, foreground, frame);
      canvasVideoTrack?.requestFrame?.();
      frame += 1;

      if ((performance.now() - startedAt) / 1000 >= duration) {
        resolve();
        return;
      }

      requestAnimationFrame(tick);
    };

    tick();
  });

  audio?.pause();
}

async function createAudioElement(
  url: string,
  audioContext: AudioContext,
  audioDestination: MediaStreamAudioDestinationNode,
): Promise<HTMLAudioElement> {
  const audio = new Audio(url);
  audio.crossOrigin = "anonymous";
  audio.preload = "auto";
  audio.currentTime = 0;
  const source = audioContext.createMediaElementSource(audio);
  source.connect(audioDestination);
  await audioContext.resume();
  return audio;
}

function drawSlide(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  page: SlidePage,
  background: HTMLImageElement | null,
  foreground: HTMLImageElement | null,
  frame: number,
): void {
  context.fillStyle = "#101014";
  context.fillRect(0, 0, canvas.width, canvas.height);

  if (background) {
    drawCoverImage(context, background, 0, 0, canvas.width, canvas.height);
  } else {
    const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, "#263c52");
    gradient.addColorStop(0.52, "#15151a");
    gradient.addColorStop(1, "#6b3d2f");
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }

  context.fillStyle = "rgba(0, 0, 0, 0.42)";
  context.fillRect(0, 0, canvas.width, canvas.height);

  const padding = canvas.width * 0.08;
  const hasVisual = Boolean(foreground);
  const textWidth = hasVisual ? canvas.width * 0.43 : canvas.width * 0.76;
  const textX = hasVisual ? padding : (canvas.width - textWidth) / 2;
  const fontSize = Math.max(34, Math.floor(canvas.width / 23));
  const lines = wrapCanvasText(context, page.text, textWidth, `${fontSize}px Inter, Segoe UI, Arial`);
  const lineHeight = fontSize * 1.22;
  const textHeight = lines.length * lineHeight;
  const textY = (canvas.height - textHeight) / 2;

  context.font = `700 ${fontSize}px Inter, Segoe UI, Arial`;
  context.textBaseline = "top";
  context.fillStyle = "#ffffff";
  lines.forEach((line, index) => {
    context.fillText(line, textX, textY + index * lineHeight);
  });

  if (foreground) {
    const boxX = canvas.width * 0.56;
    const boxY = canvas.height * 0.16;
    const boxWidth = canvas.width * 0.34;
    const boxHeight = canvas.height * 0.68;
    drawContainImage(context, foreground, boxX, boxY, boxWidth, boxHeight);
  }

  context.fillStyle = frame % 2 === 0 ? "rgba(255, 255, 255, 0.01)" : "rgba(0, 0, 0, 0.01)";
  context.fillRect(canvas.width - 1, canvas.height - 1, 1, 1);
}

function drawCoverImage(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  context.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
}

function drawContainImage(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  context.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
}

function wrapCanvasText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  font: string,
): string[] {
  context.font = font;
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";

  words.forEach((word) => {
    const testLine = line ? `${line} ${word}` : word;
    if (context.measureText(testLine).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = testLine;
    }
  });

  if (line) {
    lines.push(line);
  }

  return lines.length ? lines : [""];
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Image illisible"));
    image.src = url;
  });
}

function readMediaDuration(url: string): Promise<number> {
  return new Promise((resolve) => {
    const audio = new Audio(url);
    audio.addEventListener("loadedmetadata", () => {
      resolve(Number.isFinite(audio.duration) ? audio.duration : 0);
    });
    audio.addEventListener("error", () => resolve(0));
  });
}

function chooseMimeType(): string {
  const preferredTypes = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  return preferredTypes.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

async function urlToDataUrl(url: string): Promise<string> {
  if (!url) {
    return "";
  }

  if (url.startsWith("data:")) {
    return url;
  }

  const blob = await fetch(url).then((response) => response.blob());
  return blobToDataUrl(blob);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      resolve(typeof reader.result === "string" ? reader.result : "");
    });
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(blob);
  });
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function clampIndex(value: number, length: number, fallback: number): number {
  if (!Number.isInteger(value) || value < 0 || value >= length) {
    return fallback;
  }

  return value;
}

function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(1)} s`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

render();
