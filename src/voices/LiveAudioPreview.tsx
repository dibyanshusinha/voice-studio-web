/** Keeps the original audio element/source stable while Web Audio applies live sound controls. */
import React, {useEffect, useRef} from 'react';
import {createPreviewAudioGraph, type PreviewAudioSettings} from './preview-audio';

/** Creates one processing graph on the first user playback gesture; slider updates never replace the audio URL. */
export default function LiveAudioPreview({src, settings, onPlaybackStart, onError}: {
  src: string; settings: PreviewAudioSettings; onPlaybackStart: () => void; onError: (message: string) => void;
}) {
  const element = useRef<HTMLAudioElement>(null);
  const resources = useRef<{context: AudioContext; source: MediaElementAudioSourceNode; graph: ReturnType<typeof createPreviewAudioGraph>}>();
  const latestSettings = useRef(settings); latestSettings.current = settings;
  useEffect(() => {resources.current?.graph.applySettings(settings, true);}, [settings]);
  useEffect(() => () => {
    const current = resources.current;
    if (current) {current.source.disconnect(); current.graph.disconnect(); void current.context.close(); resources.current = undefined;}
  }, []);

  /** Resumes Web Audio inside the native play gesture, retaining the same source across pause, seek and slider changes. */
  async function handlePlay() {
    onPlaybackStart();
    let openingContext: AudioContext | undefined;
    try {
      if (!resources.current) {
        openingContext = new AudioContext();
        const source = openingContext.createMediaElementSource(element.current!);
        const graph = createPreviewAudioGraph(openingContext, latestSettings.current);
        source.connect(graph.input);
        resources.current = {context:openingContext, source, graph};
      }
      await resources.current.context.resume();
    } catch (reason) {
      element.current?.pause();
      if (openingContext && !resources.current) void openingContext.close();
      onError(`Preview playback failed: ${String(reason)}`);
    }
  }
  return <audio ref={element} controls controlsList="nodownload" src={src} aria-label="Live voice preview" onPlay={() => void handlePlay()}/>;
}
