import "./style.css";

type SlidePage = {
  id: string;
  title: string;
  text: string;
  duration: number;
  backgroundUrl: string;
  foregroundUrl: string;
  screenVideoUrl: string;
  screenVideoDuration: number;
  screenTrimStart: number;
  screenTrimEnd: number;
  screenAudioEnabled: boolean;
  voiceUrl: string;
  voiceDuration: number;
  voiceSourceDuration: number;
  voiceOffset: number;
  audioGroupId: string;
  audioGroupSize: number;
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
  name?: string;
  resolutionIndex: number;
  qualityIndex: number;
  pages: Array<{
    title: string;
    text: string;
    duration: number;
    backgroundUrl: string;
    foregroundUrl: string;
    screenVideoUrl: string;
    screenVideoDuration: number;
    screenTrimStart: number;
    screenTrimEnd: number;
    screenAudioEnabled?: boolean;
    voiceUrl: string;
    voiceDuration: number;
    voiceSourceDuration?: number;
    voiceOffset?: number;
    audioGroupId?: string;
    audioGroupSize?: number;
  }>;
};

type PresentationListItem = {
  id: string;
  name: string;
  size: number;
  updatedAt: string;
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
const AUDIO_BITS_PER_SECOND = 256_000;
const SCREEN_CAPTURE_VIDEO_BITS_PER_SECOND = 8_000_000;

const state = {
  pages: [createPage(1)],
  selectedPageId: "",
  presentationName: "Nouvelle presentation",
  backendDirectory: "",
  exportDirectory: "",
  backendReady: false,
  presentationFiles: [] as PresentationListItem[],
  selectedPresentationFile: "",
  isZoomed: false,
  audioTargetPageIds: [] as string[],
  resolutionIndex: 1,
  qualityIndex: 1,
  isRecording: false,
  recorder: null as MediaRecorder | null,
  recordedChunks: [] as Blob[],
  recordedStream: null as MediaStream | null,
  recordingTargetPageIds: [] as string[],
  isScreenRecording: false,
  screenRecorder: null as MediaRecorder | null,
  screenChunks: [] as Blob[],
  screenStream: null as MediaStream | null,
  screenRecordingStartedAt: 0,
  isRendering: false,
  renderProgress: "",
  videoUrl: "",
  videoSize: 0,
  backendVideoUrl: "",
  backendVideoPath: "",
  backendVideoSize: 0,
  backendVideoUpdatedAt: "",
};

state.selectedPageId = state.pages[0].id;
state.audioTargetPageIds = [state.pages[0].id];

let backendVideoLookupTimer = 0;

function createPage(position: number): SlidePage {
  void position;
  return {
    id: crypto.randomUUID(),
    title: "",
    text: "",
    duration: DEFAULT_PAGE_DURATION_SECONDS,
    backgroundUrl: "",
    foregroundUrl: "",
    screenVideoUrl: "",
    screenVideoDuration: 0,
    screenTrimStart: 0,
    screenTrimEnd: 0,
    screenAudioEnabled: true,
    voiceUrl: "",
    voiceDuration: 0,
    voiceSourceDuration: 0,
    voiceOffset: 0,
    audioGroupId: "",
    audioGroupSize: 1,
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
  if (page.voiceUrl) {
    return normalizeDuration(page.voiceDuration);
  }

  const screenDuration = clippedScreenDuration(page);
  const duration = page.screenVideoUrl ? screenDuration : page.duration;
  return normalizeDuration(duration);
}

function clippedScreenDuration(page: SlidePage): number {
  if (!page.screenVideoUrl || page.screenVideoDuration <= 0) {
    return 0;
  }

  const start = clampNumber(page.screenTrimStart, 0, page.screenVideoDuration);
  const end = clampNumber(page.screenTrimEnd || page.screenVideoDuration, start + MIN_PAGE_DURATION_SECONDS, page.screenVideoDuration);
  return Math.max(end - start, MIN_PAGE_DURATION_SECONDS);
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
  const audioTargetPages = state.pages.filter((item) => state.audioTargetPageIds.includes(item.id));
  const unitAudioBlocked = audioTargetPages.length === 1
    && audioTargetPages[0].audioGroupId !== ""
    && audioTargetPages[0].audioGroupSize > 1;
  const audioActionDisabled = audioTargetPages.length === 0 || unitAudioBlocked;

  if (state.isZoomed) {
    app.innerHTML = `
      <main class="zoom-shell">
        <div class="zoom-toolbar">
          <strong>${escapeHtml(page.title || "Page courante")}</strong>
          <div class="zoom-actions">
            ${state.isRecording ? `<span class="recording-indicator">Enregistrement vocal en cours</span><button id="stopZoomVoice" type="button">Arreter la voix</button>` : ""}
            <button id="closeZoom" type="button">Fermer zoom</button>
          </div>
        </div>
        <div class="zoom-preview">${slidePreviewTemplate(page)}</div>
      </main>
    `;
    bindZoomEvents();
    return;
  }

  window.onkeydown = null;

  app.innerHTML = `
    <main class="app-shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">Presentation Video Generator</p>
          <h1>Generateur de videos de presentation</h1>
        </div>
        <div class="top-actions">
          <button id="newPresentation" type="button">Nouvelle presentation</button>
          <button class="primary-action" id="generateVideo" type="button" ${state.isRendering ? "disabled" : ""}>
            Generer la video
          </button>
        </div>
      </header>

      <section class="project-bar" aria-label="Gestion des presentations">
        <label class="project-name-field">
          Nom de la presentation
          <input id="presentationName" type="text" value="${escapeHtml(state.presentationName)}" />
        </label>
        <label class="project-select-field">
          Presentations du dossier
          <select id="presentationSelect" ${state.backendReady ? "" : "disabled"}>
            <option value="">${state.presentationFiles.length ? "Selectionner..." : "Aucune presentation"}</option>
            ${state.presentationFiles.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === state.selectedPresentationFile ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}
          </select>
        </label>
        <div class="project-actions">
          <button id="savePresentation" type="button" ${state.backendReady ? "" : "disabled"}>Enregistrer</button>
          <button id="openPresentation" type="button" ${state.selectedPresentationFile ? "" : "disabled"}>Ouvrir</button>
          <button id="deletePresentation" class="danger" type="button" ${state.selectedPresentationFile ? "" : "disabled"}>Supprimer</button>
        </div>
        <p class="project-directory">${state.backendReady ? `Stockage: ${escapeHtml(state.backendDirectory)}` : "API backend indisponible"}</p>
      </section>

      <section class="workspace">
        <aside class="page-panel" aria-label="Pages">
          <div class="panel-head">
            <h2>Pages</h2>
            <button id="addPage" type="button">Creer page</button>
          </div>
          <div class="audio-selection-tools">
            <span>Pages audio: ${audioTargetPages.length}</span>
            <button id="selectAllAudioPages" type="button">Toutes</button>
            <button id="clearAudioPageSelection" type="button">Aucune</button>
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
          <div class="preview-toolbar">
            <strong>${escapeHtml(page.title || "Page courante")}</strong>
            <button id="zoomPage" type="button">Zoom</button>
          </div>
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
            Nom de la page
            <input id="pageTitle" type="text" value="${escapeHtml(page.title)}" placeholder="Nom de la page" />
          </label>

          <label>
            Texte
            <textarea id="pageText" rows="7">${escapeHtml(page.text)}</textarea>
          </label>

          <div class="file-grid">
            <label class="load-button batch-image-button" for="batchImagesInput">Creer pages depuis images</label>
            <input id="batchImagesInput" class="hidden-file" type="file" accept="image/*" multiple />
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

          <section class="screen-box">
            <div>
              <h3>Video d'ecran</h3>
              <p>${page.screenVideoUrl ? `Capture: ${formatSeconds(page.screenVideoDuration)} / extrait ${formatSeconds(clippedScreenDuration(page))}` : "Aucune capture video"}</p>
            </div>
            <div class="screen-actions">
              <button id="recordScreen" type="button">${state.isScreenRecording ? "Arreter capture" : "Capturer ecran"}</button>
              <button id="toggleScreenAudio" type="button" ${page.screenVideoUrl ? "" : "disabled"}>${page.screenAudioEnabled ? "Audio capture actif" : "Audio capture coupe"}</button>
              <button id="clearScreen" type="button" ${page.screenVideoUrl || state.isScreenRecording ? "" : "disabled"}>Effacer capture</button>
            </div>
            ${
              page.screenVideoUrl
                ? `
                  <div class="visual-trim" id="visualTrim" style="--trim-start: ${trimPercent(page.screenTrimStart, page.screenVideoDuration)}%; --trim-end: ${trimPercent(page.screenTrimEnd || page.screenVideoDuration, page.screenVideoDuration)}%;">
                    <div class="trim-track">
                      <div class="trim-selection"></div>
                      <button id="trimStartHandle" class="trim-handle trim-handle-start" type="button" aria-label="Deplacer le debut"></button>
                      <button id="trimEndHandle" class="trim-handle trim-handle-end" type="button" aria-label="Deplacer la fin"></button>
                    </div>
                    <div class="trim-readout">
                      <span id="trimStartLabel">Debut ${formatSeconds(page.screenTrimStart)}</span>
                      <span id="trimDurationLabel">Extrait ${formatSeconds(clippedScreenDuration(page))}</span>
                      <span id="trimEndLabel">Fin ${formatSeconds(page.screenTrimEnd || page.screenVideoDuration)}</span>
                    </div>
                  </div>
                  <div class="trim-preview-grid">
                    <figure class="trim-preview-card">
                      <video id="trimStartPreview" class="trim-preview-video" src="${page.screenVideoUrl}" muted playsinline preload="metadata"></video>
                      <figcaption>Image debut</figcaption>
                    </figure>
                    <figure class="trim-preview-card">
                      <video id="trimEndPreview" class="trim-preview-video" src="${page.screenVideoUrl}" muted playsinline preload="metadata"></video>
                      <figcaption>Image fin</figcaption>
                    </figure>
                  </div>
                  <div class="trim-actions">
                    <button id="playTrimPreview" type="button">Lire extrait</button>
                  </div>
                  <div class="trim-grid">
                    <label>Debut extrait (s)<input id="screenTrimStart" type="number" min="0" max="${page.screenVideoDuration}" step="0.1" value="${page.screenTrimStart}" /></label>
                    <label>Fin extrait (s)<input id="screenTrimEnd" type="number" min="0" max="${page.screenVideoDuration}" step="0.1" value="${page.screenTrimEnd || page.screenVideoDuration}" /></label>
                  </div>
                `
                : ""
            }
          </section>

          <section class="voice-box">
            <div>
              <h3>Piste audio</h3>
              <p>${page.voiceUrl
                ? page.audioGroupId && page.audioGroupSize > 1
                  ? `Piste partagee: segment ${formatSeconds(page.voiceDuration)} sur ${page.audioGroupSize} pages`
                  : `Piste de la page: ${formatSeconds(page.voiceDuration)}`
                : "Aucune piste audio"}</p>
              <p>${audioTargetPages.length > 1 ? `La piste sera partagee entre ${audioTargetPages.length} pages.` : unitAudioBlocked ? "Piste unitaire bloquee: cette page appartient a un groupe." : `${audioTargetPages.length} page selectionnee.`}</p>
            </div>
            <div class="voice-actions">
              <button id="recordVoice" type="button" ${audioActionDisabled && !state.isRecording ? "disabled" : ""}>${state.isRecording ? "Arreter" : "Enregistrer"}</button>
              <label class="load-button voice-file-button ${audioActionDisabled ? "is-disabled" : ""}" for="voiceFileInput" aria-disabled="${audioActionDisabled}">Ajouter WAV</label>
              <input id="voiceFileInput" class="hidden-file" type="file" accept="audio/wav,audio/x-wav,.wav" ${audioActionDisabled ? "disabled" : ""} />
              <button id="clearVoice" type="button" ${page.voiceUrl || state.isRecording ? "" : "disabled"}>Effacer</button>
            </div>
            ${
              page.voiceUrl
                ? `<audio class="voice-player" src="${page.voiceUrl}" controls></audio>`
                : page.screenVideoUrl
                  ? `<p class="status">Sans voix, la duree suit l'extrait video.</p>`
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
            <div class="export-actions">
              <button id="generateBackendVideo" type="button" ${state.isRendering || !state.backendReady ? "disabled" : ""}>
                Generer cote back
              </button>
            </div>
            <p class="status">${state.exportDirectory ? `Repertoire de generation: ${escapeHtml(state.exportDirectory)}` : "Repertoire de generation indisponible."}</p>
            <p class="status">${state.renderProgress}</p>
            ${state.videoUrl ? `
              <div class="generated-video-panel">
                <p class="status">Apercu navigateur: ${formatFileSize(state.videoSize)}</p>
                <video class="generated-video" src="${state.videoUrl}" controls></video>
              </div>
            ` : ""}
            ${state.backendVideoUrl ? `
              <div class="generated-video-panel">
                <p class="status">Derniere video: ${formatFileSize(state.backendVideoSize)}${state.backendVideoUpdatedAt ? ` - ${formatDateTime(state.backendVideoUpdatedAt)}` : ""}</p>
                <video class="generated-video" src="${state.backendVideoUrl}" controls></video>
              </div>
            ` : ""}
            ${state.backendVideoPath ? `<p class="status">Fichier: ${escapeHtml(state.backendVideoPath)}</p>` : ""}
          </section>
        </aside>
      </section>
    </main>
  `;

  bindEvents();
}

function pageButtonTemplate(page: SlidePage, index: number): string {
  const selected = page.id === state.selectedPageId ? "is-selected" : "";
  const audioSelected = state.audioTargetPageIds.includes(page.id);
  const displayTitle = page.title.trim() || `Page ${index + 1}`;
  return `
    <div class="page-list-item ${audioSelected ? "is-audio-selected" : ""}">
      <label class="audio-page-check" title="Selectionner pour la piste audio">
        <input type="checkbox" data-audio-page-id="${page.id}" ${audioSelected ? "checked" : ""} aria-label="Audio ${escapeHtml(displayTitle)}" />
      </label>
      <button class="page-card ${selected}" type="button" data-page-id="${page.id}">
        <span>${index + 1}</span>
        <strong>${escapeHtml(displayTitle)}</strong>
        <small>${formatSeconds(effectiveDuration(page))}</small>
      </button>
    </div>
  `;
}

function slidePreviewTemplate(page: SlidePage): string {
  const backgroundStyle = !page.screenVideoUrl && page.backgroundUrl ? `style="background-image: url('${page.backgroundUrl}')"` : "";
  const bodyClass = page.foregroundUrl ? "has-visual" : "text-only";
  return `
    <div class="slide-preview ${page.backgroundUrl ? "has-background" : ""} ${page.screenVideoUrl ? "has-screen-video" : ""}" ${backgroundStyle}>
      ${page.screenVideoUrl ? `<video class="slide-screen-video" src="${page.screenVideoUrl}" muted playsinline preload="metadata"></video>` : ""}
      <div class="slide-shade"></div>
      <div class="slide-content ${bodyClass}">
        <p class="slide-text">${escapeHtml(page.text)}</p>
        ${page.foregroundUrl ? `<img class="slide-visual" src="${page.foregroundUrl}" alt="" />` : ""}
      </div>
    </div>
  `;
}

function bindEvents(): void {
  document.querySelectorAll<HTMLInputElement>("[data-audio-page-id]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const pageId = checkbox.dataset.audioPageId;
      if (!pageId) {
        return;
      }
      if (checkbox.checked) {
        state.audioTargetPageIds = Array.from(new Set([...state.audioTargetPageIds, pageId]));
      } else {
        state.audioTargetPageIds = state.audioTargetPageIds.filter((id) => id !== pageId);
      }
      render();
    });
  });

  document.querySelector<HTMLButtonElement>("#selectAllAudioPages")?.addEventListener("click", () => {
    state.audioTargetPageIds = state.pages.map((item) => item.id);
    render();
  });

  document.querySelector<HTMLButtonElement>("#clearAudioPageSelection")?.addEventListener("click", () => {
    state.audioTargetPageIds = [];
    render();
  });

  document.querySelector<HTMLInputElement>("#presentationName")?.addEventListener("input", (event) => {
    state.presentationName = (event.currentTarget as HTMLInputElement).value;
    scheduleBackendVideoLookup();
  });

  document.querySelector<HTMLSelectElement>("#presentationSelect")?.addEventListener("change", (event) => {
    state.selectedPresentationFile = (event.currentTarget as HTMLSelectElement).value;
    render();
  });

  document.querySelector<HTMLButtonElement>("#openPresentation")?.addEventListener("click", () => {
    void openSelectedPresentation();
  });

  document.querySelector<HTMLButtonElement>("#deletePresentation")?.addEventListener("click", () => {
    void deleteSelectedPresentation();
  });

  document.querySelector<HTMLButtonElement>("#zoomPage")?.addEventListener("click", () => {
    state.isZoomed = true;
    render();
  });

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
    state.audioTargetPageIds = [page.id];
    render();
  });

  document.querySelector<HTMLButtonElement>("#deletePage")?.addEventListener("click", () => {
    if (state.pages.length === 1) {
      return;
    }
    const index = state.pages.findIndex((item) => item.id === state.selectedPageId);
    const deletedPageId = state.pages[index].id;
    state.pages.splice(index, 1);
    state.selectedPageId = state.pages[Math.max(0, index - 1)].id;
    state.audioTargetPageIds = state.audioTargetPageIds.filter((id) => id !== deletedPageId);
    refreshAudioGroups();
    render();
  });

  document.querySelector<HTMLButtonElement>("#moveUp")?.addEventListener("click", () => movePage(-1));
  document.querySelector<HTMLButtonElement>("#moveDown")?.addEventListener("click", () => movePage(1));

  document.querySelector<HTMLTextAreaElement>("#pageText")?.addEventListener("input", (event) => {
    selectedPage().text = (event.currentTarget as HTMLTextAreaElement).value;
    updatePreviewOnly();
  });

  document.querySelector<HTMLInputElement>("#pageTitle")?.addEventListener("input", (event) => {
    selectedPage().title = (event.currentTarget as HTMLInputElement).value;
    updatePageListLabel();
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

  document.querySelector<HTMLInputElement>("#batchImagesInput")?.addEventListener("change", (event) => {
    void createPagesFromImages(event.currentTarget as HTMLInputElement);
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

  document.querySelector<HTMLInputElement>("#voiceFileInput")?.addEventListener("change", (event) => {
    void handleVoiceFile(event.currentTarget as HTMLInputElement);
  });

  document.querySelector<HTMLButtonElement>("#recordScreen")?.addEventListener("click", () => {
    void toggleScreenRecording();
  });

  document.querySelector<HTMLButtonElement>("#clearScreen")?.addEventListener("click", () => {
    clearScreenVideo();
  });

  document.querySelector<HTMLButtonElement>("#toggleScreenAudio")?.addEventListener("click", () => {
    const page = selectedPage();
    page.screenAudioEnabled = !page.screenAudioEnabled;
    render();
  });

  document.querySelector<HTMLInputElement>("#screenTrimStart")?.addEventListener("input", (event) => {
    const input = event.currentTarget as HTMLInputElement;
    setScreenTrimStart(input.valueAsNumber);
  });

  document.querySelector<HTMLInputElement>("#screenTrimEnd")?.addEventListener("input", (event) => {
    const input = event.currentTarget as HTMLInputElement;
    setScreenTrimEnd(input.valueAsNumber);
  });

  setupVisualTrimDragging();

  document.querySelector<HTMLButtonElement>("#playTrimPreview")?.addEventListener("click", () => {
    void playTrimPreview();
  });

  document.querySelectorAll<HTMLVideoElement>(".trim-preview-video").forEach((video) => {
    video.addEventListener("loadedmetadata", () => {
      updateScreenDurationFromVideo(video);
      syncTrimPreviewVideos();
    });
  });

  document.querySelector<HTMLVideoElement>(".slide-screen-video")?.addEventListener("loadedmetadata", () => {
    updateScreenDurationFromVideo(document.querySelector<HTMLVideoElement>(".slide-screen-video"));
    seekScreenPlayer(selectedPage().screenTrimStart);
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

  document.querySelector<HTMLButtonElement>("#generateBackendVideo")?.addEventListener("click", () => {
    void generateBackendVideo();
  });

  document.querySelector<HTMLButtonElement>("#newPresentation")?.addEventListener("click", () => {
    newPresentation();
  });

  document.querySelector<HTMLButtonElement>("#savePresentation")?.addEventListener("click", () => {
    void savePresentation();
  });

  if (selectedPage().screenVideoUrl) {
    requestAnimationFrame(() => {
      syncTrimControls();
    });
  }
}

function bindZoomEvents(): void {
  document.querySelector<HTMLButtonElement>("#closeZoom")?.addEventListener("click", () => {
    state.isZoomed = false;
    render();
  });

  document.querySelector<HTMLButtonElement>("#stopZoomVoice")?.addEventListener("click", () => {
    state.recorder?.stop();
  });

  window.onkeydown = (event) => {
    if (event.key === "Escape") {
      state.isZoomed = false;
      render();
    }
  };

  document.querySelector<HTMLVideoElement>(".slide-screen-video")?.addEventListener("loadedmetadata", () => {
    seekScreenPlayer(selectedPage().screenTrimStart);
  });
}

function updatePreviewOnly(): void {
  const frame = document.querySelector<HTMLElement>("#previewFrame");
  if (frame) {
    frame.innerHTML = slidePreviewTemplate(selectedPage());
  }
}

function updatePageListLabel(): void {
  const page = selectedPage();
  const index = state.pages.indexOf(page);
  const label = page.title.trim() || `Page ${index + 1}`;
  const selectedButton = document.querySelector<HTMLElement>(".page-card.is-selected strong");
  const previewTitle = document.querySelector<HTMLElement>(".preview-toolbar strong");

  if (selectedButton) {
    selectedButton.textContent = label;
  }
  if (previewTitle) {
    previewTitle.textContent = label;
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
  refreshAudioGroups();
  render();
}

async function handleImageInput(input: HTMLInputElement, key: "backgroundUrl" | "foregroundUrl"): Promise<void> {
  const file = input.files?.[0];

  if (!file) {
    return;
  }

  const page = selectedPage();
  page[key] = URL.createObjectURL(file);
  if (isPageUntitled(page)) {
    page.title = fileBaseName(file.name);
  }
  render();
}

async function createPagesFromImages(input: HTMLInputElement): Promise<void> {
  const files = Array.from(input.files ?? []).filter((file) => file.type.startsWith("image/"));

  if (files.length === 0) {
    return;
  }

  const createdPages: SlidePage[] = [];
  files.forEach((file) => {
    const page = createPage(state.pages.length + createdPages.length + 1);
    page.title = fileBaseName(file.name);
    page.backgroundUrl = URL.createObjectURL(file);
    createdPages.push(page);
  });

  const firstPage = state.pages[0];
  if (state.pages.length === 1 && isFreshPage(firstPage)) {
    const [replacement, ...remaining] = createdPages;
    state.pages[0] = replacement;
    state.pages.push(...remaining);
  } else {
    state.pages.push(...createdPages);
  }

  state.selectedPageId = createdPages[0].id;
  state.audioTargetPageIds = createdPages.map((page) => page.id);
  input.value = "";
  render();
}

function isPageUntitled(page: SlidePage): boolean {
  return page.title.trim() === "" || /^Page \d+$/i.test(page.title.trim());
}

function isFreshPage(page: SlidePage): boolean {
  return isPageUntitled(page)
    && page.text.trim() === ""
    && !page.backgroundUrl
    && !page.foregroundUrl
    && !page.screenVideoUrl
    && !page.voiceUrl;
}

function fileBaseName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}

function normalizedPresentationName(): string {
  const name = state.presentationName.trim();
  return name || "Nouvelle presentation";
}

function presentationFileName(name: string): string {
  const safeName = (name.trim() || "Nouvelle presentation")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/[. ]+$/g, "")
    .slice(0, 100);
  return `${safeName || "Nouvelle presentation"}.presentation.json`;
}

function presentationNameFromFile(fileName: string): string {
  return fileName.replace(/\.presentation\.json$/i, "");
}

async function toggleRecording(): Promise<void> {
  if (state.isRecording) {
    state.recorder?.stop();
    return;
  }

  const targets = selectedAudioTargetPages();
  if (!canAssignAudioToTargets(targets)) {
    render();
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    state.renderProgress = "Votre navigateur ne permet pas l'enregistrement audio.";
    render();
    return;
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      autoGainControl: false,
      channelCount: 2,
      echoCancellation: false,
      noiseSuppression: false,
      sampleRate: 48_000,
    },
  });
  state.recordedStream = stream;
  state.recordedChunks = [];
  state.recordingTargetPageIds = targets.map((page) => page.id);
  const audioMimeType = chooseAudioMimeType();
  const audioRecorderOptions: MediaRecorderOptions = {
    audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
  };

  if (audioMimeType) {
    audioRecorderOptions.mimeType = audioMimeType;
  }

  state.recorder = new MediaRecorder(stream, audioRecorderOptions);
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
  state.isZoomed = true;
  render();
}

async function saveRecording(): Promise<void> {
  state.recordedStream?.getTracks().forEach((track) => track.stop());
  const blob = new Blob(state.recordedChunks, { type: "audio/webm" });
  const url = URL.createObjectURL(blob);
  const duration = await readMediaDuration(url);
  assignAudioToPages(url, duration, state.recordingTargetPageIds);
  state.isRecording = false;
  state.recorder = null;
  state.recordedStream = null;
  state.recordingTargetPageIds = [];
  state.isZoomed = false;
  render();
}

function clearVoice(): void {
  if (state.isRecording) {
    state.recorder?.stop();
    return;
  }
  const page = selectedPage();
  if (page.audioGroupId && page.audioGroupSize > 1) {
    state.pages.filter((item) => item.audioGroupId === page.audioGroupId).forEach(clearPageAudio);
  } else {
    clearPageAudio(page);
  }
  render();
}

async function handleVoiceFile(input: HTMLInputElement): Promise<void> {
  const file = input.files?.[0];

  if (!file) {
    return;
  }

  if (!file.name.toLowerCase().endsWith(".wav")) {
    state.renderProgress = "Selectionnez un fichier WAV.";
    input.value = "";
    render();
    return;
  }

  const targets = selectedAudioTargetPages();
  if (!canAssignAudioToTargets(targets)) {
    input.value = "";
    render();
    return;
  }

  const url = URL.createObjectURL(file);
  const duration = await readMediaDuration(url);

  if (duration <= 0) {
    URL.revokeObjectURL(url);
    state.renderProgress = "Impossible de lire ce fichier WAV.";
    input.value = "";
    render();
    return;
  }

  assignAudioToPages(url, duration, targets.map((page) => page.id));
  if (targets.length === 1 && isPageUntitled(targets[0])) {
    targets[0].title = fileBaseName(file.name);
  }
  state.renderProgress = "Piste WAV ajoutee.";
  input.value = "";
  render();
}

function selectedAudioTargetPages(): SlidePage[] {
  return state.pages.filter((page) => state.audioTargetPageIds.includes(page.id));
}

function canAssignAudioToTargets(targets: SlidePage[]): boolean {
  if (targets.length === 0) {
    state.renderProgress = "Selectionnez au moins une page pour la piste audio.";
    return false;
  }

  if (targets.length === 1 && targets[0].audioGroupId && targets[0].audioGroupSize > 1) {
    state.renderProgress = "Cette page appartient a une piste partagee. Effacez d'abord la piste du groupe.";
    return false;
  }

  return true;
}

function assignAudioToPages(url: string, totalDuration: number, pageIds: string[]): void {
  const targets = state.pages.filter((page) => pageIds.includes(page.id));
  if (targets.length === 0 || totalDuration <= 0) {
    return;
  }

  detachAudioGroupsForPages(targets);
  const groupId = targets.length > 1 ? crypto.randomUUID() : "";
  const segmentDuration = totalDuration / targets.length;

  targets.forEach((page, index) => {
    page.voiceUrl = url;
    page.voiceDuration = segmentDuration;
    page.voiceSourceDuration = totalDuration;
    page.voiceOffset = index * segmentDuration;
    page.audioGroupId = groupId;
    page.audioGroupSize = targets.length;
  });
}

function detachAudioGroupsForPages(targets: SlidePage[]): void {
  const groupIds = new Set(targets.map((page) => page.audioGroupId).filter(Boolean));
  state.pages.forEach((page) => {
    if (targets.includes(page) || (page.audioGroupId && groupIds.has(page.audioGroupId))) {
      clearPageAudio(page);
    }
  });
}

function clearPageAudio(page: SlidePage): void {
  page.voiceUrl = "";
  page.voiceDuration = 0;
  page.voiceSourceDuration = 0;
  page.voiceOffset = 0;
  page.audioGroupId = "";
  page.audioGroupSize = 1;
}

function refreshAudioGroups(): void {
  const groupIds = new Set(state.pages.map((page) => page.audioGroupId).filter(Boolean));
  groupIds.forEach((groupId) => {
    const pages = state.pages.filter((page) => page.audioGroupId === groupId);
    const sourceDuration = pages[0]?.voiceSourceDuration || pages.reduce((sum, page) => sum + page.voiceDuration, 0);

    if (pages.length === 1) {
      pages[0].audioGroupId = "";
      pages[0].audioGroupSize = 1;
      pages[0].voiceOffset = 0;
      pages[0].voiceDuration = sourceDuration;
      return;
    }

    const segmentDuration = sourceDuration / pages.length;
    pages.forEach((page, index) => {
      page.audioGroupSize = pages.length;
      page.voiceDuration = segmentDuration;
      page.voiceOffset = index * segmentDuration;
      page.voiceSourceDuration = sourceDuration;
    });
  });
}

async function toggleScreenRecording(): Promise<void> {
  if (state.isScreenRecording) {
    state.screenRecorder?.stop();
    return;
  }

  if (!navigator.mediaDevices?.getDisplayMedia || typeof MediaRecorder === "undefined") {
    state.renderProgress = "Votre navigateur ne permet pas la capture d'ecran.";
    render();
    return;
  }

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: {
      autoGainControl: false,
      channelCount: 2,
      echoCancellation: false,
      noiseSuppression: false,
      sampleRate: 48_000,
    },
  });
  state.screenStream = stream;
  state.screenChunks = [];
  state.screenRecordingStartedAt = performance.now();
  const hasCapturedAudio = stream.getAudioTracks().length > 0;
  const screenMimeType = hasCapturedAudio ? chooseMimeType() : chooseVideoMimeType();
  const screenRecorderOptions: MediaRecorderOptions = {
    videoBitsPerSecond: SCREEN_CAPTURE_VIDEO_BITS_PER_SECOND,
  };

  if (hasCapturedAudio) {
    screenRecorderOptions.audioBitsPerSecond = AUDIO_BITS_PER_SECOND;
  }
  if (screenMimeType) {
    screenRecorderOptions.mimeType = screenMimeType;
  }

  state.screenRecorder = new MediaRecorder(stream, screenRecorderOptions);
  state.isScreenRecording = true;

  state.screenRecorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) {
      state.screenChunks.push(event.data);
    }
  });

  state.screenRecorder.addEventListener("stop", () => {
    void saveScreenRecording();
  });

  stream.getVideoTracks()[0]?.addEventListener("ended", () => {
    state.screenRecorder?.stop();
  });

  state.screenRecorder.start(250);
  render();
}

async function saveScreenRecording(): Promise<void> {
  state.screenStream?.getTracks().forEach((track) => track.stop());
  const blob = new Blob(state.screenChunks, { type: state.screenRecorder?.mimeType || "video/webm" });
  const url = URL.createObjectURL(blob);
  const fallbackDuration = Math.max(MIN_PAGE_DURATION_SECONDS, (performance.now() - state.screenRecordingStartedAt) / 1000);
  const page = selectedPage();
  page.screenVideoUrl = url;
  page.screenVideoDuration = await readMediaDuration(url, fallbackDuration, "video");
  page.screenTrimStart = 0;
  page.screenTrimEnd = page.screenVideoDuration;
  page.screenAudioEnabled = true;
  state.isScreenRecording = false;
  state.screenRecorder = null;
  state.screenStream = null;
  state.screenRecordingStartedAt = 0;
  render();
}

function clearScreenVideo(): void {
  if (state.isScreenRecording) {
    state.screenRecorder?.stop();
    return;
  }
  const page = selectedPage();
  page.screenVideoUrl = "";
  page.screenVideoDuration = 0;
  page.screenTrimStart = 0;
  page.screenTrimEnd = 0;
  page.screenAudioEnabled = true;
  render();
}

function setupVisualTrimDragging(): void {
  const track = document.querySelector<HTMLElement>(".trim-track");
  const startHandle = document.querySelector<HTMLButtonElement>("#trimStartHandle");
  const endHandle = document.querySelector<HTMLButtonElement>("#trimEndHandle");

  if (!track || !startHandle || !endHandle) {
    return;
  }

  let activeEdge: "start" | "end" | null = null;

  const valueFromPointer = (event: PointerEvent): number => {
    const page = selectedPage();
    const rect = track.getBoundingClientRect();
    const ratio = clampNumber((event.clientX - rect.left) / rect.width, 0, 1);
    return ratio * page.screenVideoDuration;
  };

  const moveEdge = (edge: "start" | "end", event: PointerEvent): void => {
    if (edge === "start") {
      setScreenTrimStart(valueFromPointer(event));
    } else {
      setScreenTrimEnd(valueFromPointer(event));
    }
  };

  const beginDrag = (edge: "start" | "end", event: PointerEvent): void => {
    activeEdge = edge;
    track.setPointerCapture(event.pointerId);
    moveEdge(edge, event);
  };

  startHandle.addEventListener("pointerdown", (event) => {
    beginDrag("start", event);
  });

  endHandle.addEventListener("pointerdown", (event) => {
    beginDrag("end", event);
  });

  track.addEventListener("pointerdown", (event) => {
    if (event.target === startHandle || event.target === endHandle) {
      return;
    }

    const page = selectedPage();
    const value = valueFromPointer(event);
    const end = page.screenTrimEnd || page.screenVideoDuration;
    beginDrag(Math.abs(value - page.screenTrimStart) <= Math.abs(value - end) ? "start" : "end", event);
  });

  track.addEventListener("pointermove", (event) => {
    if (activeEdge) {
      moveEdge(activeEdge, event);
    }
  });

  track.addEventListener("pointerup", () => {
    activeEdge = null;
  });

  track.addEventListener("pointercancel", () => {
    activeEdge = null;
  });
}

function setScreenTrimStart(value: number): void {
  const page = selectedPage();
  const maxStart = Math.max(0, page.screenVideoDuration - MIN_PAGE_DURATION_SECONDS);
  const currentEnd = page.screenTrimEnd || page.screenVideoDuration;
  page.screenTrimStart = clampNumber(value, 0, Math.min(maxStart, currentEnd - MIN_PAGE_DURATION_SECONDS));
  seekScreenPlayer(page.screenTrimStart);
  syncTrimControls();
}

function setScreenTrimEnd(value: number): void {
  const page = selectedPage();
  page.screenTrimEnd = clampNumber(value, page.screenTrimStart + MIN_PAGE_DURATION_SECONDS, page.screenVideoDuration);
  seekScreenPlayer(page.screenTrimEnd);
  syncTrimControls();
}

function syncTrimControls(): void {
  const page = selectedPage();
  const end = page.screenTrimEnd || page.screenVideoDuration;
  const visualTrim = document.querySelector<HTMLElement>("#visualTrim");
  const startInput = document.querySelector<HTMLInputElement>("#screenTrimStart");
  const endInput = document.querySelector<HTMLInputElement>("#screenTrimEnd");
  const startLabel = document.querySelector<HTMLElement>("#trimStartLabel");
  const endLabel = document.querySelector<HTMLElement>("#trimEndLabel");
  const durationLabel = document.querySelector<HTMLElement>("#trimDurationLabel");

  visualTrim?.style.setProperty("--trim-start", `${trimPercent(page.screenTrimStart, page.screenVideoDuration)}%`);
  visualTrim?.style.setProperty("--trim-end", `${trimPercent(end, page.screenVideoDuration)}%`);

  if (startInput) {
    startInput.value = page.screenTrimStart.toFixed(1);
  }
  if (endInput) {
    endInput.value = end.toFixed(1);
  }
  if (startLabel) {
    startLabel.textContent = `Debut ${formatSeconds(page.screenTrimStart)}`;
  }
  if (endLabel) {
    endLabel.textContent = `Fin ${formatSeconds(end)}`;
  }
  if (durationLabel) {
    durationLabel.textContent = `Extrait ${formatSeconds(clippedScreenDuration(page))}`;
  }

  syncTrimPreviewVideos();
}

function syncTrimPreviewVideos(): void {
  const page = selectedPage();
  const end = page.screenTrimEnd || page.screenVideoDuration;
  const startPreview = document.querySelector<HTMLVideoElement>("#trimStartPreview");
  const endPreview = document.querySelector<HTMLVideoElement>("#trimEndPreview");

  seekPreviewVideo(startPreview, page.screenTrimStart);
  seekPreviewVideo(endPreview, end);
}

function updateScreenDurationFromVideo(video: HTMLVideoElement | null): void {
  const page = selectedPage();

  if (!video || !page.screenVideoUrl || !Number.isFinite(video.duration) || video.duration <= 0) {
    return;
  }

  if (page.screenVideoDuration > 0) {
    return;
  }

  page.screenVideoDuration = video.duration;
  page.screenTrimStart = 0;
  page.screenTrimEnd = video.duration;
  syncTrimControls();
}

function seekPreviewVideo(video: HTMLVideoElement | null, time: number): void {
  if (!video || !Number.isFinite(video.duration)) {
    return;
  }

  const safeTime = clampNumber(time, 0, Math.max(0, video.duration - 0.05));
  if (Math.abs(video.currentTime - safeTime) > 0.05) {
    video.currentTime = safeTime;
  }
}

async function playTrimPreview(): Promise<void> {
  const player = document.querySelector<HTMLVideoElement>(".slide-screen-video");
  const page = selectedPage();

  if (!player || !page.screenVideoUrl) {
    return;
  }

  await ensureVideoReady(player);
  const end = page.screenTrimEnd || page.screenVideoDuration;
  player.pause();
  player.currentTime = clampNumber(page.screenTrimStart, 0, Math.max(0, player.duration - 0.05));
  await waitForSeek(player);
  player.ontimeupdate = () => {
    if (player.currentTime >= end) {
      player.pause();
      player.currentTime = clampNumber(end, 0, Math.max(0, player.duration - 0.05));
      player.ontimeupdate = null;
    }
  };
  await player.play().catch(() => undefined);
}

function seekScreenPlayer(time: number): void {
  const player = document.querySelector<HTMLVideoElement>(".slide-screen-video");

  if (!player) {
    return;
  }

  player.pause();
  player.ontimeupdate = null;
  const safeMax = Number.isFinite(player.duration) ? Math.max(0, player.duration - 0.05) : time;
  player.currentTime = clampNumber(time, 0, safeMax);
}

function newPresentation(): void {
  if (state.isRecording) {
    state.recorder?.stop();
  }
  if (state.isScreenRecording) {
    state.screenRecorder?.stop();
  }

  state.pages = [createPage(1)];
  state.selectedPageId = state.pages[0].id;
  state.audioTargetPageIds = [state.pages[0].id];
  state.presentationName = "Nouvelle presentation";
  state.selectedPresentationFile = "";
  state.resolutionIndex = 1;
  state.qualityIndex = 1;
  state.videoUrl = "";
  state.videoSize = 0;
  state.backendVideoUrl = "";
  state.backendVideoPath = "";
  state.backendVideoSize = 0;
  state.backendVideoUpdatedAt = "";
  state.renderProgress = "Nouvelle presentation creee.";
  render();
  void refreshBackendVideoStatus().then(() => render());
}

async function refreshPresentationFiles(): Promise<void> {
  const response = await fetch("/api/presentations", { cache: "no-store" });
  if (!response.ok) {
    throw new Error("API indisponible");
  }

  const payload = await response.json() as {
    presentationDirectory: string;
    exportDirectory?: string;
    presentations: PresentationListItem[];
  };
  state.backendReady = true;
  state.backendDirectory = payload.presentationDirectory;
  state.exportDirectory = payload.exportDirectory ?? "";
  state.presentationFiles = payload.presentations;

  if (state.selectedPresentationFile && !state.presentationFiles.some((item) => item.id === state.selectedPresentationFile)) {
    state.selectedPresentationFile = "";
  }
}

function clearBackendVideoStatus(): void {
  state.backendVideoUrl = "";
  state.backendVideoPath = "";
  state.backendVideoSize = 0;
  state.backendVideoUpdatedAt = "";
}

function scheduleBackendVideoLookup(): void {
  window.clearTimeout(backendVideoLookupTimer);
  clearBackendVideoStatus();
  backendVideoLookupTimer = window.setTimeout(() => {
    void refreshBackendVideoStatus().then(() => render());
  }, 350);
}

async function refreshBackendVideoStatus(): Promise<void> {
  if (!state.backendReady) {
    clearBackendVideoStatus();
    return;
  }

  try {
    const response = await fetch(`/api/exports/latest?name=${encodeURIComponent(normalizedPresentationName())}`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Video introuvable");
    }

    const payload = await response.json() as {
      exists: boolean;
      url: string;
      outputPath: string;
      size: number;
      updatedAt: string;
    };

    if (payload.exists) {
      const cacheKey = payload.updatedAt || String(Date.now());
      state.backendVideoUrl = `${payload.url}?v=${encodeURIComponent(cacheKey)}`;
      state.backendVideoPath = payload.outputPath;
      state.backendVideoSize = payload.size;
      state.backendVideoUpdatedAt = payload.updatedAt;
    } else {
      clearBackendVideoStatus();
    }
  } catch {
    clearBackendVideoStatus();
  }
}

async function openSelectedPresentation(): Promise<void> {
  if (!state.selectedPresentationFile) {
    return;
  }

  try {
    const response = await fetch(`/api/presentations/${encodeURIComponent(state.selectedPresentationFile)}`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Chargement impossible");
    }
    const rawPresentation = await response.json() as Partial<SavedPresentation>;
    applySavedPresentation(rawPresentation, presentationNameFromFile(state.selectedPresentationFile));
    await refreshBackendVideoStatus();
    render();
  } catch {
    state.renderProgress = "Impossible d'ouvrir cette presentation.";
    render();
  }
}

async function deleteSelectedPresentation(): Promise<void> {
  if (!state.selectedPresentationFile) {
    return;
  }

  if (!window.confirm(`Supprimer ${presentationNameFromFile(state.selectedPresentationFile)} ?`)) {
    return;
  }

  try {
    const response = await fetch(`/api/presentations/${encodeURIComponent(state.selectedPresentationFile)}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      throw new Error("Suppression impossible");
    }
    state.selectedPresentationFile = "";
    await refreshPresentationFiles();
    state.renderProgress = "Presentation supprimee.";
  } catch {
    state.renderProgress = "Impossible de supprimer cette presentation.";
  }

  render();
}

async function savePresentation(): Promise<void> {
  if (!state.backendReady) {
    state.renderProgress = "L'API backend est indisponible.";
    render();
    return;
  }

  state.renderProgress = "Sauvegarde de la presentation...";
  render();

  try {
    const presentation = await buildSavedPresentation();
    const fileName = presentationFileName(state.presentationName);
    const response = await fetch(`/api/presentations/${encodeURIComponent(fileName)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(presentation),
    });
    if (!response.ok) {
      throw new Error("Sauvegarde impossible");
    }
    state.selectedPresentationFile = fileName;
    await refreshPresentationFiles();
    await refreshBackendVideoStatus();
    state.renderProgress = "Presentation sauvegardee.";
  } catch {
    state.renderProgress = "Impossible de sauvegarder la presentation.";
  }

  render();
}

async function buildSavedPresentation(): Promise<SavedPresentation> {
  return {
    app: "presentation-video-generator",
    version: 1,
    name: normalizedPresentationName(),
    resolutionIndex: state.resolutionIndex,
    qualityIndex: state.qualityIndex,
    pages: await Promise.all(
      state.pages.map(async (page) => ({
        title: page.title,
        text: page.text,
        duration: normalizeDuration(page.duration),
        backgroundUrl: await urlToDataUrl(page.backgroundUrl),
        foregroundUrl: await urlToDataUrl(page.foregroundUrl),
        screenVideoUrl: await urlToDataUrl(page.screenVideoUrl),
        screenVideoDuration: page.screenVideoDuration,
        screenTrimStart: page.screenTrimStart,
        screenTrimEnd: page.screenTrimEnd,
        screenAudioEnabled: page.screenAudioEnabled,
        voiceUrl: await urlToDataUrl(page.voiceUrl),
        voiceDuration: page.voiceDuration,
        voiceSourceDuration: page.voiceSourceDuration,
        voiceOffset: page.voiceOffset,
        audioGroupId: page.audioGroupId,
        audioGroupSize: page.audioGroupSize,
      })),
    ),
  };
}

function applySavedPresentation(rawPresentation: Partial<SavedPresentation>, fallbackName: string): void {
  if (rawPresentation.app !== "presentation-video-generator" || !Array.isArray(rawPresentation.pages)) {
    throw new Error("Format invalide");
  }

  state.pages = rawPresentation.pages.map((page) => ({
    id: crypto.randomUUID(),
    title: typeof page.title === "string" ? page.title : "",
    text: typeof page.text === "string" ? page.text : "",
    duration: normalizeDuration(Number(page.duration)),
    backgroundUrl: typeof page.backgroundUrl === "string" ? page.backgroundUrl : "",
    foregroundUrl: typeof page.foregroundUrl === "string" ? page.foregroundUrl : "",
    screenVideoUrl: typeof page.screenVideoUrl === "string" ? page.screenVideoUrl : "",
    screenVideoDuration: Math.max(0, Number(page.screenVideoDuration) || 0),
    screenTrimStart: Math.max(0, Number(page.screenTrimStart) || 0),
    screenTrimEnd: Math.max(0, Number(page.screenTrimEnd) || 0),
    screenAudioEnabled: page.screenAudioEnabled !== false,
    voiceUrl: typeof page.voiceUrl === "string" ? page.voiceUrl : "",
    voiceDuration: typeof page.voiceUrl === "string" && page.voiceUrl ? normalizeDuration(Number(page.voiceDuration)) : 0,
    voiceSourceDuration: typeof page.voiceUrl === "string" && page.voiceUrl
      ? Math.max(0, Number(page.voiceSourceDuration) || Number(page.voiceDuration) || 0)
      : 0,
    voiceOffset: Math.max(0, Number(page.voiceOffset) || 0),
    audioGroupId: typeof page.audioGroupId === "string" ? page.audioGroupId : "",
    audioGroupSize: Math.max(1, Number(page.audioGroupSize) || 1),
  }));

  if (state.pages.length === 0) {
    state.pages = [createPage(1)];
  }

  state.presentationName = typeof rawPresentation.name === "string" && rawPresentation.name.trim()
    ? rawPresentation.name
    : fallbackName;
  state.selectedPageId = state.pages[0].id;
  state.audioTargetPageIds = [state.pages[0].id];
  refreshAudioGroups();
  state.resolutionIndex = clampIndex(Number(rawPresentation.resolutionIndex), resolutions.length, 1);
  state.qualityIndex = clampIndex(Number(rawPresentation.qualityIndex), qualities.length, 1);
  state.videoUrl = "";
  state.videoSize = 0;
  clearBackendVideoStatus();
  state.renderProgress = "Presentation chargee.";
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
  const hasAudio = state.pages.some((page) => Boolean(page.voiceUrl || (page.screenVideoUrl && page.screenAudioEnabled)));
  const audioContext = hasAudio ? new AudioContext({ sampleRate: 48_000 }) : null;
  const audioDestination = audioContext?.createMediaStreamDestination() ?? null;
  audioDestination?.stream.getAudioTracks().forEach((track) => canvasStream.addTrack(track));

  const mimeType = chooseMimeType();
  const recorderOptions: MediaRecorderOptions = {
    videoBitsPerSecond: quality.videoBitsPerSecond,
  };

  if (hasAudio) {
    recorderOptions.audioBitsPerSecond = AUDIO_BITS_PER_SECOND;
  }
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

async function generateBackendVideo(): Promise<void> {
  if (state.isRendering) {
    return;
  }

  if (!state.backendReady) {
    state.renderProgress = "L'API backend est indisponible.";
    render();
    return;
  }

  state.isRendering = true;
  state.videoUrl = "";
  state.videoSize = 0;
  state.backendVideoUrl = "";
  state.backendVideoPath = "";
  state.backendVideoSize = 0;
  state.backendVideoUpdatedAt = "";
  state.renderProgress = "Creation de l'export backend...";
  render();

  try {
    const startResponse = await fetch("/api/exports", { method: "POST" });
    if (!startResponse.ok) {
      throw new Error("Creation export impossible");
    }

    const startPayload = await startResponse.json() as { jobId: string };
    const hasAudio = state.pages.some((page) => Boolean(page.voiceUrl || (page.screenVideoUrl && page.screenAudioEnabled)));

    for (let index = 0; index < state.pages.length; index += 1) {
      const page = state.pages[index];
      state.renderProgress = `Rendu et envoi page ${index + 1} / ${state.pages.length}`;
      render();

      const chunk = await renderPageChunk(page, hasAudio);
      if (chunk.size === 0) {
        throw new Error(`Morceau vide pour la page ${index + 1}`);
      }

      const uploadResponse = await fetch(`/api/exports/${encodeURIComponent(startPayload.jobId)}/chunks/${index}`, {
        method: "PUT",
        headers: { "Content-Type": chunk.type || "video/webm" },
        body: chunk,
      });
      if (!uploadResponse.ok) {
        throw new Error(`Envoi impossible pour la page ${index + 1}`);
      }
    }

    state.renderProgress = "Assemblage backend avec ffmpeg...";
    render();

    const finishResponse = await fetch(`/api/exports/${encodeURIComponent(startPayload.jobId)}/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: normalizedPresentationName() }),
    });
    if (!finishResponse.ok) {
      throw new Error("Assemblage backend impossible");
    }

    const finishPayload = await finishResponse.json() as { url: string; outputPath: string; size: number; updatedAt: string };
    const cacheKey = finishPayload.updatedAt || String(Date.now());
    state.backendVideoUrl = `${finishPayload.url}?v=${encodeURIComponent(cacheKey)}`;
    state.backendVideoPath = finishPayload.outputPath;
    state.backendVideoSize = finishPayload.size;
    state.backendVideoUpdatedAt = finishPayload.updatedAt;
    state.renderProgress = "Video backend prete.";
  } catch (error) {
    state.renderProgress = error instanceof Error ? error.message : "Generation backend impossible.";
  } finally {
    state.isRendering = false;
    render();
  }
}

async function renderPageChunk(page: SlidePage, forceAudio: boolean): Promise<Blob> {
  if (typeof MediaRecorder === "undefined") {
    throw new Error("Votre navigateur ne permet pas l'export video.");
  }

  const resolution = resolutions[state.resolutionIndex];
  const quality = qualities[state.qualityIndex];
  const canvas = document.createElement("canvas");
  canvas.width = resolution.width;
  canvas.height = resolution.height;
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Canvas indisponible.");
  }

  const canvasStream = canvas.captureStream(0);
  const canvasVideoTrack = canvasStream.getVideoTracks()[0] as (MediaStreamTrack & { requestFrame?: () => void }) | undefined;
  const audioContext = forceAudio ? new AudioContext({ sampleRate: 48_000 }) : null;
  const audioDestination = audioContext?.createMediaStreamDestination() ?? null;
  audioDestination?.stream.getAudioTracks().forEach((track) => canvasStream.addTrack(track));
  const mimeType = chooseMimeType();
  const recorderOptions: MediaRecorderOptions = {
    videoBitsPerSecond: quality.videoBitsPerSecond,
  };

  if (forceAudio) {
    recorderOptions.audioBitsPerSecond = AUDIO_BITS_PER_SECOND;
  }
  if (mimeType) {
    recorderOptions.mimeType = mimeType;
  }

  const recorder = new MediaRecorder(canvasStream, recorderOptions);
  const chunks: Blob[] = [];
  const finished = new Promise<Blob>((resolve) => {
    recorder.addEventListener("stop", () => {
      resolve(new Blob(chunks, { type: mimeType || "video/webm" }));
    });
  });

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  });

  try {
    recorder.start(250);
    await wait(100);
    await drawPageForDuration(context, canvas, page, audioContext, audioDestination, canvasVideoTrack);
    recorder.requestData();
    await wait(250);
    recorder.stop();
    return await finished;
  } finally {
    await audioContext?.close();
    canvasStream.getTracks().forEach((track) => track.stop());
  }
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
  const screenVideo = page.screenVideoUrl ? await loadVideo(page.screenVideoUrl, !page.screenAudioEnabled) : null;
  const duration = effectiveDuration(page);
  const trimEnd = page.screenTrimEnd || page.screenVideoDuration;
  const startedAt = performance.now();
  const screenAudioSource = screenVideo && page.screenAudioEnabled && audioContext && audioDestination
    ? connectMediaElementToMix(screenVideo, audioContext, audioDestination)
    : null;
  const voiceAudio = page.voiceUrl && audioContext && audioDestination
    ? await createAudioElement(page.voiceUrl, audioContext, audioDestination, page.voiceOffset)
    : null;
  const silentAudio = audioContext && audioDestination && !screenAudioSource && !voiceAudio
    ? connectSilentAudio(audioContext, audioDestination)
    : null;

  if (screenVideo) {
    screenVideo.currentTime = page.screenTrimStart;
    await waitForSeek(screenVideo);
    await screenVideo.play().catch(() => undefined);
  }
  await audioContext?.resume();
  voiceAudio?.play();
  silentAudio?.start();

  await new Promise<void>((resolve) => {
    let frame = 0;

    const tick = (): void => {
      if (screenVideo && screenVideo.currentTime >= trimEnd) {
        screenVideo.pause();
        screenVideo.currentTime = Math.max(page.screenTrimStart, trimEnd - 0.05);
      }

      drawSlide(context, canvas, page, background, foreground, screenVideo, frame);
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

  screenAudioSource?.disconnect();
  silentAudio?.stop();
  silentAudio?.disconnect();
  voiceAudio?.pause();
  screenVideo?.pause();
}

async function createAudioElement(
  url: string,
  audioContext: AudioContext,
  audioDestination: MediaStreamAudioDestinationNode,
  offset = 0,
): Promise<HTMLAudioElement> {
  const audio = new Audio(url);
  audio.crossOrigin = "anonymous";
  audio.preload = "auto";
  await ensureMediaMetadata(audio);
  const maximumOffset = Number.isFinite(audio.duration) ? Math.max(0, audio.duration - 0.05) : offset;
  audio.currentTime = clampNumber(offset, 0, maximumOffset);
  const source = audioContext.createMediaElementSource(audio);
  source.connect(audioDestination);
  await audioContext.resume();
  return audio;
}

function ensureMediaMetadata(media: HTMLMediaElement): Promise<void> {
  if (media.readyState >= HTMLMediaElement.HAVE_METADATA && Number.isFinite(media.duration)) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    media.addEventListener("loadedmetadata", () => resolve(), { once: true });
    media.addEventListener("error", () => resolve(), { once: true });
  });
}

function connectMediaElementToMix(
  media: HTMLMediaElement,
  audioContext: AudioContext,
  audioDestination: MediaStreamAudioDestinationNode,
): MediaElementAudioSourceNode {
  const source = audioContext.createMediaElementSource(media);
  source.connect(audioDestination);
  return source;
}

function connectSilentAudio(
  audioContext: AudioContext,
  audioDestination: MediaStreamAudioDestinationNode,
): ConstantSourceNode {
  const source = audioContext.createConstantSource();
  source.offset.value = 0;
  source.connect(audioDestination);
  return source;
}

function drawSlide(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  page: SlidePage,
  background: HTMLImageElement | null,
  foreground: HTMLImageElement | null,
  screenVideo: HTMLVideoElement | null,
  frame: number,
): void {
  context.fillStyle = "#101014";
  context.fillRect(0, 0, canvas.width, canvas.height);

  if (screenVideo && screenVideo.videoWidth > 0 && screenVideo.videoHeight > 0) {
    drawCoverVideo(context, screenVideo, 0, 0, canvas.width, canvas.height);
  } else if (background) {
    drawContainImage(context, background, 0, 0, canvas.width, canvas.height);
  } else {
    const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, "#263c52");
    gradient.addColorStop(0.52, "#15151a");
    gradient.addColorStop(1, "#6b3d2f");
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }

  if (screenVideo) {
    context.fillStyle = "rgba(0, 0, 0, 0.08)";
    context.fillRect(0, 0, canvas.width, canvas.height);
  }

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
  context.shadowColor = "rgba(0, 0, 0, 0.7)";
  context.shadowBlur = Math.max(8, Math.floor(fontSize * 0.28));
  context.shadowOffsetY = Math.max(2, Math.floor(fontSize * 0.08));
  lines.forEach((line, index) => {
    context.fillText(line, textX, textY + index * lineHeight);
  });
  context.shadowColor = "transparent";
  context.shadowBlur = 0;
  context.shadowOffsetY = 0;

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

function drawCoverVideo(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const scale = Math.max(width / video.videoWidth, height / video.videoHeight);
  const drawWidth = video.videoWidth * scale;
  const drawHeight = video.videoHeight * scale;
  context.drawImage(video, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
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

function loadVideo(url: string, muted = true): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = muted;
    video.playsInline = true;
    video.preload = "auto";
    video.addEventListener("loadedmetadata", () => resolve(video), { once: true });
    video.addEventListener("error", () => reject(new Error("Video illisible")), { once: true });
    video.src = url;
  });
}

function waitForSeek(video: HTMLVideoElement): Promise<void> {
  if (!video.seeking) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    video.addEventListener("seeked", () => resolve(), { once: true });
  });
}

function ensureVideoReady(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA && Number.isFinite(video.duration)) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    video.addEventListener("loadedmetadata", () => resolve(), { once: true });
    video.addEventListener("error", () => resolve(), { once: true });
  });
}

function readMediaDuration(url: string, fallback = 0, kind: "audio" | "video" = "audio"): Promise<number> {
  return new Promise((resolve) => {
    const media = kind === "video" ? document.createElement("video") : new Audio();
    media.preload = "metadata";
    media.addEventListener("loadedmetadata", () => {
      resolve(Number.isFinite(media.duration) && media.duration > 0 ? media.duration : fallback);
    });
    media.addEventListener("error", () => resolve(fallback));
    media.src = url;
  });
}

function chooseMimeType(): string {
  const preferredTypes = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  return preferredTypes.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

function chooseVideoMimeType(): string {
  const preferredTypes = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  return preferredTypes.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

function chooseAudioMimeType(): string {
  const preferredTypes = ["audio/webm;codecs=opus", "audio/webm"];
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

function clampIndex(value: number, length: number, fallback: number): number {
  if (!Number.isInteger(value) || value < 0 || value >= length) {
    return fallback;
  }

  return value;
}

function clampNumber(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }

  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(Math.max(value, min), max);
}

function trimPercent(value: number, duration: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(duration) || duration <= 0) {
    return 0;
  }

  return clampNumber((value / duration) * 100, 0, 100);
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

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
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
void refreshPresentationFiles()
  .then(() => refreshBackendVideoStatus())
  .then(() => render())
  .catch(() => {
    state.backendReady = false;
    state.backendDirectory = "";
    state.exportDirectory = "";
    state.renderProgress = "API backend indisponible.";
    render();
  });
