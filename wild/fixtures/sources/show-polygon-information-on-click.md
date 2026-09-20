# Fixture sources for `show-polygon-information-on-click`

| file | what the app asked for | origin / license | size | sha256 |
|---|---|---|---|---|
| `ne_110m_admin_1_states_provinces_shp.geojson` | `https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_110m_admin_1_states_provinces_shp.geojson` | Natural Earth 1:110m Cultural Vectors, "Admin 1 – States, Provinces" (`ne_110m_admin_1_states_provinces_shp`), **public domain** (Natural Earth: "No permission is needed to use Natural Earth. Crediting the authors is unnecessary."); redistributed at this exact URL by `maplibre.org`'s own example (same CloudFront asset the upstream page fetches; confirmed via `curl -I`, `Content-Length: 130428`, well under the 1.5 MB limit) | 130 KB | `653630e6540e63d8` |

Contents: 51 polygon features, all `admin: "United States of America"` (the 50 states + DC), with the
full Natural Earth attribute set (`scalerank`, `adm1_code`, `name`, `postal`, `region`, `wikipedia`, …).
Evidence of license: https://www.naturalearthdata.com/about/terms-of-use/ ("All versions of Natural
Earth raster + vector map data found on this website are in the public domain.").
