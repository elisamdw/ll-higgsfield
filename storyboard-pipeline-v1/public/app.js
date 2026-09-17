const $ = (selector) => document.querySelector(selector)

const elements = {
  form: $('#brief-form'),
  concept: $('#concept'),
  style: $('#style'),
  aspectRatio: $('#aspect-ratio'),
  stepPicker: $('#step-picker'),
  stepPickerSummary: $('#step-picker-summary'),
  createButton: $('#create-storyboard'),
  emptyState: $('#empty-state'),
  busyState: $('#busy-state'),
  busyTitle: $('#busy-title'),
  boardView: $('#board-view'),
  frameBoard: $('#frame-board'),
  orderList: $('#order-list'),
  continuitySummary: $('#continuity-summary'),
  renderPanel: $('#render-panel'),
  runPanel: $('#run-panel'),
  projectTitle: $('#project-title'),
  newBoard: $('#new-board'),
  openRender: $('#open-render'),
  motionPrompt: $('#motion-prompt'),
  videoModel: $('#video-model'),
  duration: $('#duration'),
  resolution: $('#resolution'),
  generateAudio: $('#generate-audio'),
  preflightButton: $('#preflight'),
  costDialog: $('#cost-dialog'),
  confirmModel: $('#confirm-model'),
  confirmDuration: $('#confirm-duration'),
  confirmFrames: $('#confirm-frames'),
  confirmCost: $('#confirm-cost'),
  confirmGenerate: $('#confirm-generate'),
  editDialog: $('#edit-dialog'),
  editTitle: $('#edit-title'),
  editShotTitle: $('#edit-shot-title'),
  editBeat: $('#edit-beat'),
  editCamera: $('#edit-camera'),
  editTransition: $('#edit-transition'),
  editImagePrompt: $('#edit-image-prompt'),
  editRegenerate: $('#edit-regenerate'),
  confirmEdit: $('#confirm-edit'),
  runTitle: $('#run-title'),
  runMessage: $('#run-message'),
  resultMedia: $('#result-media'),
  globalError: $('#global-error'),
  storyboardDot: $('#storyboard-dot'),
  storyboardStatus: $('#storyboard-status'),
  higgsfieldDot: $('#higgsfield-dot'),
  higgsfieldStatus: $('#higgsfield-status'),
  checkHiggsfield: $('#check-higgsfield'),
}

const DEFAULT_STEP_COUNT = 4

const state = {
  health: null,
  project: null,
  order: [],
  preflight: null,
  run: null,
  draggedId: null,
  editFrameId: null,
  pollVersion: 0,
  selectedSteps: new Set(),
  stepCatalog: [],
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body
      ? { 'content-type': 'application/json', ...(options.headers ?? {}) }
      : options.headers,
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error || `Request failed (${response.status}).`)
  }
  return payload
}

function setError(error = '') {
  const message = typeof error === 'string' ? error : error?.message || 'Something went wrong.'
  elements.globalError.textContent = message
  elements.globalError.hidden = !message
  if (message) window.setTimeout(() => {
    if (elements.globalError.textContent === message) elements.globalError.hidden = true
  }, 9_000)
}

function setButtonBusy(button, busy, label) {
  if (!button.dataset.label) button.dataset.label = button.querySelector('span')?.textContent || button.textContent
  button.disabled = busy
  const target = button.querySelector('span') || button
  target.textContent = busy ? label : button.dataset.label
}

function setStage(stage) {
  const titles = {
    brief: 'Build a visual sequence',
    board: state.project?.title || 'The storyboard',
    render: state.project?.title || 'Render the sequence',
  }
  elements.projectTitle.textContent = titles[stage]
  document.querySelectorAll('.step').forEach((step) => {
    step.classList.toggle('is-active', step.dataset.step === stage)
  })
}

function showOnly(...visible) {
  const panels = [elements.emptyState, elements.busyState, elements.boardView, elements.renderPanel, elements.runPanel]
  panels.forEach((panel) => { panel.hidden = !visible.includes(panel) })
}

function frameById(id) {
  return state.project?.frames.find((frame) => frame.id === id)
}

function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function moveFrame(frameId, nextIndex) {
  const currentIndex = state.order.indexOf(frameId)
  if (currentIndex < 0) return
  const boundedIndex = Math.max(0, Math.min(nextIndex, state.order.length - 1))
  state.order.splice(currentIndex, 1)
  state.order.splice(boundedIndex, 0, frameId)
  state.preflight = null
  renderBoard()
}

function dropFrame(frameId, targetId, after) {
  if (!frameId || frameId === targetId) return
  const next = state.order.filter((id) => id !== frameId)
  const targetIndex = next.indexOf(targetId)
  next.splice(targetIndex + (after ? 1 : 0), 0, frameId)
  state.order = next
  state.preflight = null
  renderBoard()
}

function openEdit(frame) {
  state.editFrameId = frame.id
  elements.editTitle.textContent = `Edit ${frame.title}`
  elements.editShotTitle.value = frame.title
  elements.editBeat.value = frame.beat
  elements.editCamera.value = frame.camera
  elements.editTransition.value = frame.transition
  elements.editImagePrompt.value = frame.imagePrompt || ''
  elements.editRegenerate.checked = false
  elements.editDialog.showModal()
  elements.editShotTitle.focus()
}

function makeFrameCard(frame, orderIndex) {
  const card = element('article', 'frame-card')
  card.setAttribute('role', 'listitem')
  card.setAttribute('tabindex', '0')
  card.setAttribute('draggable', 'true')
  card.dataset.id = frame.id

  const imageWrap = element('div', 'frame-image')
  const image = document.createElement('img')
  image.src = `${frame.url}?v=${encodeURIComponent(state.project.updatedAt)}`
  image.alt = `${frame.title}: ${frame.beat}`
  image.loading = 'lazy'
  imageWrap.append(image, element('span', 'frame-number', `Frame ${String(orderIndex + 1).padStart(2, '0')}`))

  const body = element('div', 'frame-body')
  body.append(element('h4', '', frame.title), element('p', '', frame.beat))
  const meta = element('div', 'frame-meta')
  meta.append(element('span', '', frame.camera), element('span', '', frame.transition))

  const actions = element('div', 'frame-actions')
  const left = element('button', 'icon-button', '←')
  left.type = 'button'
  left.disabled = orderIndex === 0
  left.setAttribute('aria-label', `Move ${frame.title} left`)
  left.addEventListener('click', () => moveFrame(frame.id, orderIndex - 1))

  const right = element('button', 'icon-button', '→')
  right.type = 'button'
  right.disabled = orderIndex === state.order.length - 1
  right.setAttribute('aria-label', `Move ${frame.title} right`)
  right.addEventListener('click', () => moveFrame(frame.id, orderIndex + 1))

  const edit = element('button', 'edit-button', 'Edit')
  edit.type = 'button'
  edit.addEventListener('click', () => openEdit(frame))

  const revise = element('button', 'revise-button', 'Regenerate')
  revise.type = 'button'
  revise.addEventListener('click', () => regenerateFrameImage(frame.id))

  actions.append(left, right, edit, revise)
  body.append(meta, actions)
  card.append(imageWrap, body)

  card.addEventListener('dragstart', (event) => {
    state.draggedId = frame.id
    card.classList.add('is-dragging')
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', frame.id)
  })
  card.addEventListener('dragend', () => {
    state.draggedId = null
    document.querySelectorAll('.frame-card').forEach((item) => item.classList.remove('is-dragging', 'is-drop-target'))
  })
  card.addEventListener('dragover', (event) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    card.classList.add('is-drop-target')
  })
  card.addEventListener('dragleave', () => card.classList.remove('is-drop-target'))
  card.addEventListener('drop', (event) => {
    event.preventDefault()
    card.classList.remove('is-drop-target')
    const sourceId = state.draggedId || event.dataTransfer.getData('text/plain')
    const rect = card.getBoundingClientRect()
    dropFrame(sourceId, frame.id, event.clientX > rect.left + rect.width / 2)
  })
  card.addEventListener('keydown', (event) => {
    if (!event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return
    event.preventDefault()
    moveFrame(frame.id, orderIndex + (event.key === 'ArrowLeft' ? -1 : 1))
    elements.frameBoard.querySelector(`[data-id="${frame.id}"]`)?.focus()
  })

  return card
}

function renderBoard() {
  if (!state.project) return
  elements.frameBoard.replaceChildren()
  elements.orderList.replaceChildren()
  elements.frameBoard.dataset.ratio = state.project.aspectRatio

  state.order.forEach((id, index) => {
    const frame = frameById(id)
    if (!frame) return
    elements.frameBoard.append(makeFrameCard(frame, index))
    const item = element('li', '', String(index + 1))
    item.title = frame.title
    item.setAttribute('aria-label', `${index + 1}: ${frame.title}`)
    elements.orderList.append(item)
  })
  elements.continuitySummary.textContent = state.project.continuityBible
  elements.motionPrompt.value = state.project.motionPrompt
}

function renderStepPicker() {
  const catalog = state.stepCatalog
  if (!catalog.length) return
  if (!state.selectedSteps.size) {
    defaultStepSelection(catalog).forEach((key) => state.selectedSteps.add(key))
  }
  elements.stepPicker.replaceChildren()
  for (const entry of catalog) {
    const option = element('label', 'step-option')
    option.dataset.key = entry.key
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.value = entry.key
    input.checked = state.selectedSteps.has(entry.key)
    input.addEventListener('change', () => {
      if (input.checked) state.selectedSteps.add(entry.key)
      else state.selectedSteps.delete(entry.key)
      renderStepPicker()
    })
    const text = element('div')
    text.append(element('strong', '', entry.title), element('small', '', entry.beat))
    option.append(input, text)
    option.classList.toggle('is-selected', input.checked)
    elements.stepPicker.append(option)
  }
  updateStepPickerSummary()
}

function defaultStepSelection(catalog) {
  if (catalog.length <= DEFAULT_STEP_COUNT) return catalog.map((entry) => entry.key)
  return Array.from({ length: DEFAULT_STEP_COUNT }, (_, index) => {
    const sourceIndex = Math.round((index * (catalog.length - 1)) / (DEFAULT_STEP_COUNT - 1))
    return catalog[sourceIndex].key
  })
}

function selectedStepKeysInCatalogOrder() {
  return state.stepCatalog.filter((entry) => state.selectedSteps.has(entry.key)).map((entry) => entry.key)
}

function updateStepPickerSummary() {
  const count = state.selectedSteps.size
  const noun = count === 1 ? 'step' : 'steps'
  let message = `${count} ${noun} selected`
  if (count < 2) message += ' — pick at least 2'
  if (count > 8) message += ' — max 8'
  elements.stepPickerSummary.textContent = message
  elements.createButton.disabled = count < 2 || count > 8
}

function renderModelControls() {
  const models = state.health?.models || {}
  const profile = models[elements.videoModel.value]
  if (!profile) return

  elements.duration.replaceChildren()
  for (let seconds = profile.minDuration; seconds <= profile.maxDuration; seconds += 1) {
    const option = new Option(`${seconds}s`, String(seconds), false, seconds === profile.defaultDuration)
    elements.duration.add(option)
  }
  elements.resolution.replaceChildren()
  profile.resolutions.forEach((resolution) => {
    elements.resolution.add(new Option(resolution, resolution, false, resolution === profile.defaultResolution))
  })
  elements.generateAudio.disabled = !profile.supportsAudio
  elements.generateAudio.checked = profile.supportsAudio
  state.preflight = null
}

function currentRenderConfig() {
  return {
    order: [...state.order],
    model: elements.videoModel.value,
    duration: Number(elements.duration.value),
    resolution: elements.resolution.value,
    aspectRatio: state.project.aspectRatio,
    prompt: elements.motionPrompt.value.trim(),
    generateAudio: elements.generateAudio.checked,
  }
}

async function loadHealth() {
  try {
    const health = await api('/api/health')
    state.health = health
    state.stepCatalog = Array.isArray(health.steps) ? health.steps : []
    elements.storyboardDot.className = 'status-dot is-ready'
    elements.storyboardStatus.textContent = health.mockMode ? 'Mock mode' : health.storyboardModel === 'nano_banana_2' ? 'Nano Banana 2' : health.storyboardModel
    elements.higgsfieldDot.className = `status-dot ${health.higgsfieldInstalled ? 'is-ready' : 'is-error'}`
    elements.higgsfieldStatus.textContent = health.higgsfieldInstalled ? 'CLI installed' : 'CLI missing'
    renderModelControls()
    renderStepPicker()
  }
  catch (error) {
    setError(error)
    elements.storyboardStatus.textContent = 'Unavailable'
    elements.higgsfieldStatus.textContent = 'Unavailable'
  }
}

async function checkHiggsfieldConnection() {
  elements.checkHiggsfield.disabled = true
  elements.higgsfieldStatus.textContent = 'Checking…'
  try {
    const result = await api('/api/health/higgsfield', { method: 'POST' })
    elements.higgsfieldDot.className = 'status-dot is-ready'
    elements.higgsfieldStatus.textContent = result.authenticated ? 'Authenticated' : 'Not signed in'
  }
  catch (error) {
    elements.higgsfieldDot.className = 'status-dot is-error'
    elements.higgsfieldStatus.textContent = 'Not connected'
    setError(error)
  }
  finally {
    elements.checkHiggsfield.disabled = false
  }
}

async function createStoryboard(event) {
  event.preventDefault()
  setError()
  state.pollVersion += 1
  const steps = selectedStepKeysInCatalogOrder()
  if (steps.length < 2 || steps.length > 8) {
    setError('Pick between 2 and 8 storyboard steps.')
    return
  }
  elements.busyTitle.textContent = `Directing ${steps.length} visual beats…`
  showOnly(elements.busyState)
  setButtonBusy(elements.createButton, true, 'Building storyboard…')
  try {
    const payload = await api('/api/storyboards', {
      method: 'POST',
      body: JSON.stringify({
        concept: elements.concept.value,
        style: elements.style.value,
        steps,
        aspectRatio: elements.aspectRatio.value,
      }),
    })
    state.project = payload.project
    state.order = payload.project.frames.map((frame) => frame.id)
    state.preflight = null
    state.run = null
    elements.newBoard.hidden = false
    elements.openRender.disabled = false
    renderBoard()
    setStage('board')
    showOnly(elements.boardView)
  }
  catch (error) {
    setError(error)
    showOnly(elements.emptyState)
  }
  finally {
    setButtonBusy(elements.createButton, false)
  }
}

function resetWorkspace() {
  state.pollVersion += 1
  state.project = null
  state.order = []
  state.preflight = null
  state.run = null
  state.editFrameId = null
  elements.newBoard.hidden = true
  elements.openRender.disabled = true
  elements.resultMedia.replaceChildren()
  setStage('brief')
  showOnly(elements.emptyState)
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

function openRenderSettings() {
  if (!state.project) return
  setStage('render')
  showOnly(elements.boardView, elements.renderPanel)
  elements.renderPanel.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

async function preflightRender() {
  if (!state.project) return
  setError()
  setButtonBusy(elements.preflightButton, true, 'Checking cost…')
  try {
    const config = currentRenderConfig()
    const payload = await api(`/api/storyboards/${state.project.id}/preflight`, {
      method: 'POST',
      body: JSON.stringify(config),
    })
    state.preflight = { ...payload.preflight, config }
    const profile = state.health.models[config.model]
    elements.confirmModel.textContent = profile?.label || config.model
    elements.confirmDuration.textContent = `${config.duration} seconds · ${config.resolution}`
    elements.confirmFrames.textContent = String(config.order.length)
    elements.confirmCost.textContent = `${payload.preflight.credits} credits`
    elements.costDialog.showModal()
  }
  catch (error) {
    setError(error)
  }
  finally {
    setButtonBusy(elements.preflightButton, false)
  }
}

async function confirmGeneration() {
  if (!state.project || !state.preflight) return
  setError()
  setButtonBusy(elements.confirmGenerate, true, 'Submitting…')
  try {
    const payload = await api(`/api/storyboards/${state.project.id}/generate`, {
      method: 'POST',
      body: JSON.stringify({
        config: state.preflight.config,
        token: state.preflight.token,
        confirmed: true,
      }),
    })
    state.run = payload.run
    elements.costDialog.close()
    renderRun()
    setStage('render')
    showOnly(elements.boardView, elements.runPanel)
    elements.runPanel.scrollIntoView({ behavior: 'smooth', block: 'start' })
    void pollRun(payload.run.id)
  }
  catch (error) {
    setError(error)
  }
  finally {
    setButtonBusy(elements.confirmGenerate, false)
  }
}

function renderRun() {
  if (!state.run) return
  const titles = {
    queued: 'Queued',
    running: 'Generating video',
    completed: 'Render complete',
    failed: 'Render failed',
  }
  elements.runTitle.textContent = titles[state.run.status] || state.run.status
  elements.runMessage.textContent = state.run.error
    || state.run.message
    || (state.run.status === 'completed' ? 'The final sequence is ready.' : 'The ordered board is being rendered. You can keep this tab open.')
  elements.resultMedia.replaceChildren()

  for (const url of state.run.resultUrls ?? []) {
    const video = document.createElement('video')
    video.controls = true
    video.playsInline = true
    video.preload = 'metadata'
    video.src = url
    const link = element('a', 'result-link', 'Open generated video ↗')
    link.href = url
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    elements.resultMedia.append(video, link)
  }
}

async function pollRun(runId) {
  const version = ++state.pollVersion
  while (version === state.pollVersion) {
    await new Promise((resolve) => window.setTimeout(resolve, 3_000))
    if (version !== state.pollVersion) return
    try {
      const payload = await api(`/api/runs/${runId}`)
      state.run = payload.run
      renderRun()
      if (['completed', 'failed'].includes(state.run.status)) return
    }
    catch (error) {
      setError(error)
      return
    }
  }
}

async function regenerateFrameImage(frameId, note = '') {
  if (!state.project) return
  const frame = frameById(frameId)
  if (!frame) return
  try {
    const payload = await api(`/api/storyboards/${state.project.id}/frames/${frameId}/regenerate`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    })
    state.project = payload.project
    state.preflight = null
    renderBoard()
    elements.frameBoard.querySelector(`[data-id="${frame.id}"]`)?.scrollIntoView({ behavior: 'smooth', inline: 'center' })
  }
  catch (error) {
    setError(error)
  }
}

async function confirmFrameEdit() {
  if (!state.project || !state.editFrameId) return
  setError()
  setButtonBusy(elements.confirmEdit, true, 'Saving…')
  const frameId = state.editFrameId
  const regenerate = elements.editRegenerate.checked
  try {
    const payload = await api(`/api/storyboards/${state.project.id}/frames/${frameId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        title: elements.editShotTitle.value,
        beat: elements.editBeat.value,
        camera: elements.editCamera.value,
        transition: elements.editTransition.value,
        imagePrompt: elements.editImagePrompt.value,
      }),
    })
    state.project = payload.project
    state.preflight = null
    elements.editDialog.close()
    renderBoard()
    if (regenerate) await regenerateFrameImage(frameId)
  }
  catch (error) {
    setError(error)
  }
  finally {
    setButtonBusy(elements.confirmEdit, false)
  }
}

elements.form.addEventListener('submit', createStoryboard)
elements.checkHiggsfield.addEventListener('click', checkHiggsfieldConnection)
elements.newBoard.addEventListener('click', resetWorkspace)
elements.openRender.addEventListener('click', openRenderSettings)
elements.videoModel.addEventListener('change', renderModelControls)
elements.duration.addEventListener('change', () => { state.preflight = null })
elements.resolution.addEventListener('change', () => { state.preflight = null })
elements.generateAudio.addEventListener('change', () => { state.preflight = null })
elements.motionPrompt.addEventListener('input', () => { state.preflight = null })
elements.preflightButton.addEventListener('click', preflightRender)
elements.confirmGenerate.addEventListener('click', confirmGeneration)
elements.confirmEdit.addEventListener('click', confirmFrameEdit)

void loadHealth()
