# Logo sources

- `logo_lockup.png` — the master artwork: the giga / UNICEF / ITU lockup,
  1200x365, dark artwork on transparent. Copied verbatim to
  `warp/static/images/logo.png`, which the app shows on the index splash under
  the light theme.
- `logo_sq.png` — the giga bird cropped out of the lockup (311x249, blue only:
  the black dots read as knockout holes once it is recoloured). Master for the
  favicon, PWA icons and iOS splash screens — regenerate those with
  `res/gen_pwa_assets.sh`.

`warp/static/images/logo-white.png` is the lockup with every opaque pixel
forced to white; it is what the nav bar and the dark-theme index splash use,
since the bar is brand-coloured in both themes. Regenerate it after changing
the master with:

```sh
magick res/icons/logo_lockup.png -fill white -colorize 100 \
    warp/static/images/logo-white.png
```

The artwork is raster, so it cannot be tinted by CSS the way the old
`currentColor` SVG wordmark could — hence the two checked-in variants. Dropping
in vector sources later needs no markup change beyond the file extension.
