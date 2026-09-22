// OpenRouter conventions adapted from mk-x.
export const providers = {
  openrouter: {base: 'https://openrouter.ai/api/v1', key: 'OPENROUTER_API_KEY', header: 'Authorization', prefix: 'Bearer '},
  fal: {base: 'https://queue.fal.run', key: 'FAL_API_KEY', header: 'Authorization', prefix: 'Key '},
};

function rejectOptions(o, names, provider) {
  for (const name of names) if (o[name] !== undefined) throw new Error(`--${name} is not mapped for ${provider}; use --params-file with that model's native schema.`);
}

export function buildRequest(kind, provider, model, prompt, o = {}, refs = [], params = {}) {
  if (!providers[provider]) throw new Error(`Unknown provider: ${provider}`);
  if (!model?.trim()) throw new Error('--model is required (use the selected provider\'s model ID).');
  if (params.stream) throw new Error('Streaming is not supported by these commands.');
  let path, body;
  if (kind === 'text') {
    if (provider === 'fal') {
      path = '/fal-ai/any-llm'; body = {...params, model, prompt};
      if (o.system) body.system_prompt = o.system;
      if (o['max-tokens']) body.max_tokens = o['max-tokens'];
      if (o.temperature !== undefined) body.temperature = o.temperature;
    } else {
      path = '/chat/completions'; body = {...params, model, messages: [], stream: false};
      if (o.system) body.messages.push({role: 'system', content: o.system});
      body.messages.push({role: 'user', content: prompt});
      if (o['max-tokens']) body.max_tokens = o['max-tokens'];
      if (o.temperature !== undefined) body.temperature = o.temperature;
    }
  } else if (provider === 'openrouter') {
    rejectOptions(o, ['ref-field'], provider);
    path = '/images'; body = {...params, model, prompt};
    for (const [flag, key] of Object.entries({aspect: 'aspect_ratio', resolution: 'resolution', format: 'output_format', quality: 'quality', size: 'size', n: 'n'})) if (o[flag] !== undefined) body[key] = o[flag];
    if (refs.length) body.input_references = refs.map(r => ({type: 'image_url', image_url: {url: r.url}}));
  } else if (provider === 'fal') {
    rejectOptions(o, ['size', 'quality'], provider);
    if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+$/.test(model) || model.split('/').includes('..')) throw new Error('fal image --model must be an endpoint ID, not a URL.');
    path = `/${model}`; body = {...params, prompt};
    for (const [flag, key] of Object.entries({aspect: 'aspect_ratio', resolution: 'resolution', format: 'output_format', n: 'num_images'})) if (o[flag] !== undefined) body[key] = o[flag];
    if (refs.length) {
      const field = o['ref-field'] || 'image_urls';
      if (!['image_urls', 'image_url'].includes(field)) throw new Error('--ref-field must be image_urls or image_url.');
      if (field === 'image_url' && refs.length !== 1) throw new Error('This endpoint accepts one reference image.');
      body[field] = field === 'image_url' ? refs[0].url : refs.map(r => r.url);
    }
  } else throw new Error(`Image generation is not mapped for ${provider}.`);
  return {provider, model, url: providers[provider].base + path, body};
}

export function textResult(result) {
  if (typeof result.output === 'string') return result.output; // fal any-llm
  const chat = result.choices?.[0]?.message; // OpenRouter chat completions
  if (typeof chat?.content === 'string') return chat.content;
  const parts = chat?.content || [];
  return Array.isArray(parts) ? parts.map(p => p.text || '').join('') : '';
}

export function imageResults(result) {
  if (Array.isArray(result.data)) return result.data; // OpenRouter
  if (Array.isArray(result.images)) return result.images; // fal
  return [];
}
