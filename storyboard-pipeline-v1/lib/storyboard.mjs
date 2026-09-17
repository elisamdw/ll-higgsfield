import { normalizeStoryboardPlan } from './core.mjs'
import { saveFrame } from './store.mjs'

export const SHOT_LIBRARY = [
  {
    key: 'establish',
    title: 'Establish',
    beat: 'Establish the complete setting, the main subject, and the central visual relationship in one readable image.',
    composition: 'Wide establishing view with clear foreground, subject, and destination layers.',
    camera: 'Locked wide lens with restrained cinematic depth.',
    transition: 'Begin from stillness and ease toward the subject.',
  },
  {
    key: 'approach',
    title: 'Approach',
    beat: 'Move closer as the main subject actively engages with the object, place, or problem at the center of the concept.',
    composition: 'Medium-wide composition that preserves geography while prioritizing the action.',
    camera: 'Slow controlled push-in at eye level.',
    transition: 'Continue the establishing screen direction.',
  },
  {
    key: 'focus',
    title: 'Focus',
    beat: 'Isolate the decisive gesture or mechanism that makes the scene progress.',
    composition: 'Tight detail with one dominant focal point and recognizable contextual anchors.',
    camera: 'Close lens, shallow depth of field, stable axis.',
    transition: 'Cut on the subject’s movement or line of sight.',
  },
  {
    key: 'reveal',
    title: 'Reveal',
    beat: 'Show the concept’s central discovery or visual reversal clearly for the first time.',
    composition: 'Revealing point-of-view or over-the-shoulder composition with an unmistakable subject-object relationship.',
    camera: 'Measured dolly or optical push toward the discovery.',
    transition: 'Reveal what the previous frame was directing attention toward.',
  },
  {
    key: 'escalate',
    title: 'Escalate',
    beat: 'Increase the scale, intensity, or consequence of the reveal without introducing unrelated elements.',
    composition: 'Layered medium composition with the discovery and the subject readable together.',
    camera: 'Subtle lateral drift that adds dimensionality.',
    transition: 'Carry one shape or motion across the cut.',
  },
  {
    key: 'reframe',
    title: 'Reframe',
    beat: 'Change perspective so the audience understands the discovery’s effect on the main subject.',
    composition: 'Reverse or reaction angle that preserves the established spatial logic.',
    camera: 'Controlled reverse angle with matched eyeline and lens character.',
    transition: 'Match the prior eyeline and lighting direction.',
  },
  {
    key: 'resolve',
    title: 'Resolve',
    beat: 'Show the subject’s final response and settle the main action into a visually legible outcome.',
    composition: 'Balanced medium-wide resolution with the key subject and motif sharing the frame.',
    camera: 'Gentle pull-back or settling camera.',
    transition: 'Let motion decelerate into the final image.',
  },
  {
    key: 'echo',
    title: 'Echo',
    beat: 'End on a memorable image that echoes the opening composition and can support a loop when appropriate.',
    composition: 'Closing tableau that rhymes with the establishing geometry while showing the story’s change.',
    camera: 'Return toward the opening axis and come to rest.',
    transition: 'Resolve cleanly; if looping, align the final geometry with the first frame.',
  },
]

export const SHOT_LIBRARY_BY_KEY = Object.fromEntries(SHOT_LIBRARY.map((shot) => [shot.key, shot]))

function selectedBlueprints(count) {
  if (count === 1) return [SHOT_LIBRARY[0]]
  return Array.from({ length: count }, (_, index) => {
    const sourceIndex = Math.round((index * (SHOT_LIBRARY.length - 1)) / (count - 1))
    return SHOT_LIBRARY[sourceIndex]
  })
}

function blueprintsFor(input) {
  if (Array.isArray(input.steps) && input.steps.length) {
    return input.steps.map((key) => SHOT_LIBRARY_BY_KEY[key]).filter(Boolean)
  }
  return selectedBlueprints(input.shotCount)
}

function titleFromConcept(concept) {
  const firstSentence = concept.split(/[.!?\n]/)[0].trim()
  const words = firstSentence.split(/\s+/).slice(0, 8).join(' ')
  return words || 'Untitled storyboard'
}

export function createTemplatePlan(input) {
  const continuityBible = [
    `Concept anchor: ${input.concept}`,
    `Visual language: ${input.style}.`,
    'Preserve the same recurring people, facial traits, wardrobe, props, architecture, spatial relationships, palette, time of day, weather, and light direction in every frame.',
    'Use cinematic realism and one coherent production design. Do not add captions, panel borders, logos, watermarks, or typography.',
  ].join(' ')

  const shots = blueprintsFor(input).map((blueprint, index) => ({
    ...blueprint,
    imagePrompt: [
      `Create storyboard shot ${index + 1} of ${input.shotCount} for this concept: ${input.concept}`,
      `Narrative function: ${blueprint.beat}`,
      `Composition: ${blueprint.composition}`,
      `Camera: ${blueprint.camera}`,
      `Visual language: ${input.style}.`,
      'Make this a polished cinematic still with no text, border, caption, watermark, or storyboard annotations.',
    ].join('\n'),
  }))

  return normalizeStoryboardPlan({
    title: titleFromConcept(input.concept),
    continuityBible,
    motionPrompt: [
      `Animate the ordered storyboard as one coherent cinematic sequence about: ${input.concept}`,
      'Respect the submitted frame order exactly. Preserve subject identity, wardrobe, props, production design, lighting direction, and spatial continuity.',
      'Use restrained natural subject motion and motivated camera movement. Transition smoothly between the visual beats without inventing unrelated scenes.',
      'If the first and last compositions rhyme, make the ending settle naturally into a seamless loop.',
    ].join(' '),
    shots,
  }, input)
}

export function makeMockPlan(input) {
  return createTemplatePlan(input)
}

export async function makeMockFrame(project, frame) {
  const hue = (frame.position * 47 + 190) % 360
  const safeTitle = frame.title.replace(/[<>&]/g, '')
  const safeBeat = frame.beat.replace(/[<>&]/g, '').slice(0, 110)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="hsl(${hue} 32% 92%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360} 28% 82%)"/></linearGradient></defs><rect width="1280" height="720" fill="url(#g)"/><circle cx="${220 + frame.position * 95}" cy="255" r="145" fill="none" stroke="rgba(31,41,55,.18)" stroke-width="3"/><path d="M0 ${580 - frame.position * 18} Q 360 ${390 + frame.position * 9} 720 ${520 - frame.position * 15} T 1280 460 V720 H0Z" fill="rgba(31,41,55,.1)"/><text x="70" y="95" fill="#374151" font-family="Arial" font-size="24">Frame ${String(frame.position).padStart(2, '0')}</text><text x="70" y="560" fill="#111827" font-family="Arial" font-size="54" font-weight="600">${safeTitle}</text><text x="70" y="620" fill="rgba(31,41,55,.72)" font-family="Arial" font-size="25">${safeBeat}</text></svg>`
  return saveFrame(project.id, frame.id, Buffer.from(svg), 'image/svg+xml')
}
