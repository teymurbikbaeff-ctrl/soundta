import type { WheelEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";

type Track = {
  id: string;
  title: string;
  artist: string;
  duration: string;
  coverUrl?: string | null;
};

function App() {
  const [query, setQuery] = useState("");
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [page, setPage] = useState(0);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isTrackLoading, setIsTrackLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const wheelDeltaRef = useRef(0);
  const pageSize = 4;

  useEffect(() => {
    let mounted = true;
    let unlistenDeepLink: (() => void) | null = null;
    let unlistenAuthSuccess: (() => void) | null = null;
    let unlistenAuthError: (() => void) | null = null;

    const applyCallbackUrl = async (url: string) => {
      try {
        await invoke("save_token_input", { input: url });
        if (mounted) {
          setIsAuthenticated(true);
          setError(null);
          setIsSigningIn(false);
        }
      } catch (err) {
        if (mounted) {
          setIsSigningIn(false);
          setError(err instanceof Error ? err.message : "Sign-in failed");
        }
      }
    };

    const processUrls = async (urls: string[] | null) => {
      if (!urls || urls.length === 0) {
        return;
      }

      const callbackUrl = urls.find((value) => value.startsWith("soundta://auth"));
      if (!callbackUrl) {
        return;
      }

      await applyCallbackUrl(callbackUrl);
    };

    const initAuth = async () => {
      try {
        const hasToken = await invoke<boolean>("get_auth_status");
        if (mounted) {
          setIsAuthenticated(hasToken);
        }

        await processUrls(await getCurrent());
        unlistenDeepLink = await onOpenUrl(async (urls) => {
          await processUrls(urls);
        });
        unlistenAuthSuccess = await listen("auth://success", () => {
          if (!mounted) {
            return;
          }
          setIsAuthenticated(true);
          setError(null);
          setIsSigningIn(false);
        });
        unlistenAuthError = await listen<string>("auth://error", (event) => {
          if (!mounted) {
            return;
          }
          setIsSigningIn(false);
          setError(event.payload ?? "Sign-in failed");
        });
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : "Failed to initialize auth");
        }
      } finally {
        if (mounted) {
          setIsAuthLoading(false);
        }
      }
    };

    void initAuth();

    return () => {
      mounted = false;
      if (unlistenDeepLink) {
        unlistenDeepLink();
      }
      if (unlistenAuthSuccess) {
        unlistenAuthSuccess();
      }
      if (unlistenAuthError) {
        unlistenAuthError();
      }
    };
  }, []);

  const formatTime = (value: number) => {
    if (!Number.isFinite(value) || value <= 0) {
      return "0:00";
    }
    const minutes = Math.floor(value / 60);
    const seconds = Math.floor(value % 60);
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  const totalPages = Math.max(1, Math.ceil(tracks.length / pageSize));
  const clampedPage = Math.min(page, totalPages - 1);
  const pageTracks = tracks.slice(
    clampedPage * pageSize,
    clampedPage * pageSize + pageSize,
  );

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (tracks.length <= pageSize) {
      return;
    }

    event.preventDefault();
    wheelDeltaRef.current += event.deltaY;

    const threshold = 180;
    if (Math.abs(wheelDeltaRef.current) < threshold) {
      return;
    }

    const direction = wheelDeltaRef.current > 0 ? 1 : -1;
    wheelDeltaRef.current = 0;
    setPage((prev) => Math.min(totalPages - 1, Math.max(0, prev + direction)));
  };

  const handleSearch = async () => {
    const trimmed = query.trim();
    if (!trimmed) {
      return;
    }

    setHasSearched(false);
    setIsLoading(true);
    setError(null);
    setPage(0);

    try {
      const results = await invoke<Track[]>("search_tracks", { query: trimmed });
      setTracks(results);
      setHasSearched(true);
    } catch (err) {
      setTracks([]);
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setIsLoading(false);
    }
  };

  const handlePlay = async (track: Track) => {
    setCurrentTrack(track);
    setIsTrackLoading(true);
    setError(null);

    try {
      const url = await invoke<string>("get_stream_url", { trackId: track.id });
      if (audioRef.current) {
        audioRef.current.src = url;
        audioRef.current.currentTime = 0;
        await audioRef.current.play();
        setIsPlaying(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Playback failed");
    } finally {
      setIsTrackLoading(false);
    }
  };

  const togglePlay = async () => {
    if (!audioRef.current) {
      return;
    }

    if (audioRef.current.paused) {
      await audioRef.current.play();
      setIsPlaying(true);
    } else {
      audioRef.current.pause();
      setIsPlaying(false);
    }
  };

  const handleLoadedMetadata = () => {
    if (!audioRef.current) {
      return;
    }
    setDuration(audioRef.current.duration || 0);
  };

  const handleTimeUpdate = () => {
    if (!audioRef.current) {
      return;
    }
    setCurrentTime(audioRef.current.currentTime || 0);
  };

  const handleEnded = () => {
    setIsPlaying(false);
  };

  const handleSignIn = async () => {
    setError(null);
    setIsSigningIn(true);
    try {
      await invoke("start_yandex_oauth");
    } catch (err) {
      setIsSigningIn(false);
      setError(err instanceof Error ? err.message : "Failed to open login window");
    }
  };

  if (isAuthLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-950 text-sm text-zinc-400">
        Loading...
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="h-screen overflow-hidden bg-zinc-950 text-zinc-100">
        <div className="mx-auto flex h-full w-full max-w-md flex-col items-center justify-center gap-4 px-6">
          <h1 className="text-lg font-semibold">Sign in with Yandex</h1>
          <p className="text-center text-xs text-zinc-500">
            We capture your token automatically after successful login.
          </p>
          <button
            className="rounded-xl border border-zinc-700 bg-zinc-900 px-5 py-3 text-sm font-medium text-white"
            onClick={handleSignIn}
            disabled={isSigningIn}
          >
            {isSigningIn ? "Waiting for login..." : "Sign in with Yandex"}
          </button>
          {error ? <p className="text-center text-xs text-rose-400">{error}</p> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen overflow-hidden bg-zinc-950 text-zinc-100">
      <div
        className={`mx-auto flex h-full w-full max-w-3xl flex-col gap-6 px-6 py-10 ${
          hasSearched ? "" : "items-center justify-center"
        }`}
      >
        <section className={`w-full ${hasSearched ? "space-y-4" : "max-w-md"}`}>
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm outline-none transition focus:border-zinc-500"
              placeholder="Search track"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  handleSearch();
                }
              }}
            />
            <button
              className="rounded-xl border border-zinc-700 bg-zinc-900 px-5 py-3 text-sm font-medium text-white"
              onClick={handleSearch}
            >
              {isLoading ? "Searching..." : "Search"}
            </button>
          </div>
        </section>

        {hasSearched ? (
          <section className={`flex flex-1 flex-col space-y-3 pb-2 ${currentTrack ? "pb-28" : ""}`}>
            {error ? <p className="text-xs text-rose-400">{error}</p> : null}
            {!isLoading && pageTracks.length > 0 ? (
              <div
                className="divide-y divide-zinc-800 rounded-xl border border-zinc-800"
                onWheel={handleWheel}
              >
                {pageTracks.map((track) => (
                  <button
                    key={track.id}
                    className={`flex w-full items-center justify-between gap-4 px-4 py-4 text-left transition hover:bg-zinc-900 ${
                      currentTrack?.id === track.id ? "bg-zinc-900" : ""
                    }`}
                    onClick={() => handlePlay(track)}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      {track.coverUrl ? (
                        <img
                          src={track.coverUrl}
                          alt=""
                          className="h-11 w-11 shrink-0 rounded-md object-cover"
                        />
                      ) : (
                        <div className="h-11 w-11 shrink-0 rounded-md border border-zinc-800 bg-zinc-900" />
                      )}
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-zinc-100">{track.title}</p>
                        <p className="truncate text-xs text-zinc-500">{track.artist}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-zinc-500">
                      <span>{track.duration}</span>
                    </div>
                  </button>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}
      </div>

      {currentTrack ? (
        <div className="fixed inset-x-0 bottom-0 border-t border-zinc-800 bg-zinc-950">
          <div className="mx-auto flex w-full max-w-3xl items-center gap-4 px-6 py-4">
            <div className="flex items-center justify-center gap-2">
              <button className="flex h-9 w-9 items-center justify-center rounded-full border border-zinc-800">
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                  <path d="M19 6v12l-8.5-6L19 6zM5 6h2v12H5z" />
                </svg>
              </button>
              <button
                className="flex h-10 w-10 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900"
                onClick={togglePlay}
                disabled={isTrackLoading}
              >
                {isTrackLoading ? (
                  <span className="text-xs">...</span>
                ) : (
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                    {isPlaying ? <path d="M6 5h4v14H6zm8 0h4v14h-4z" /> : <path d="M8 5v14l11-7z" />}
                  </svg>
                )}
              </button>
              <button className="flex h-9 w-9 items-center justify-center rounded-full border border-zinc-800">
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                  <path d="M5 6v12l8.5-6L5 6zM17 6h2v12h-2z" />
                </svg>
              </button>
            </div>
            <div className="hidden w-40 sm:block">
              <div className="h-1 w-full rounded-full bg-zinc-800">
                <div
                  className="h-full rounded-full bg-zinc-200"
                  style={{ width: duration ? `${(currentTime / duration) * 100}%` : "0%" }}
                />
              </div>
            </div>
            <span className="ml-auto text-xs text-zinc-500">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>
        </div>
      ) : null}
      <audio
        ref={audioRef}
        onLoadedMetadata={handleLoadedMetadata}
        onTimeUpdate={handleTimeUpdate}
        onEnded={handleEnded}
      />
    </div>
  );
}

export default App;
