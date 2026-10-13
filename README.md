# Feed the Music Loop

A local-first vocal studio for building repeating voice layers, recording continuous vocals over the groove, and shaping the result into a song.

Implementation is in progress in this repository. The application will be published as a static GitHub Pages site. Recordings belong in browser-local project storage and exported project backups; no audio is uploaded to this repository.

## Core workflow

1. Record a free-length vocal beat and turn it into a loop.
2. Add aligned or free-length layers while the backing continues.
3. Record a continuous vocal, preserving the dry take and the stereo performance.
4. Arrange loop sections and adjust levels, tone, dynamics and space.
5. Save, reopen, back up and export the song.

## Development

The app uses browser-native ES modules, AudioWorklet and binary local storage. Runtime assets are self-contained, without an audio server or external CDN dependency.

Implementation, tests, deployment instructions and verified limitations will be documented with the first complete release.
