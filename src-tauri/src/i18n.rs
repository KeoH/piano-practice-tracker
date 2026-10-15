//! Traducción de los mensajes que el backend muestra al usuario (errores y avisos).
//!
//! Comparte los ficheros de idioma con el frontend (`src/locales/<código>.json`), que se incrustan
//! al compilar; Rust solo usa las claves `backend.*`. Los textos admiten `{nombre}` como hueco.
//! Los logs, comentarios y tests siguen en español: no son para el usuario.
//!
//! Para añadir un idioma basta con su JSON y una línea en [`LOCALES`].
//!
//! No importa `tauri::`, para poder testearlo sin app.

use std::collections::HashMap;
use std::fmt::Display;
use std::sync::{LazyLock, RwLock};

/// Idiomas disponibles: código ISO 639-1 y contenido del JSON. El primero es el de reserva.
const LOCALES: &[(&str, &str)] = &[
    ("en", include_str!("../../src/locales/en.json")),
    ("es", include_str!("../../src/locales/es.json")),
];

/// Idioma de reserva si falta una clave o no se reconoce el del sistema.
pub const FALLBACK: &str = "en";

static CATALOGS: LazyLock<HashMap<&'static str, HashMap<String, String>>> = LazyLock::new(|| {
    LOCALES
        .iter()
        .map(|(code, json)| {
            let value: serde_json::Value =
                serde_json::from_str(json).unwrap_or_else(|e| panic!("locales/{code}.json no es JSON válido: {e}"));
            let mut flat = HashMap::new();
            flatten("", &value, &mut flat);
            (*code, flat)
        })
        .collect()
});

static CURRENT: RwLock<&'static str> = RwLock::new(FALLBACK);

fn flatten(prefix: &str, value: &serde_json::Value, out: &mut HashMap<String, String>) {
    match value {
        serde_json::Value::Object(map) => {
            for (k, v) in map {
                let key = if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") };
                flatten(&key, v, out);
            }
        }
        serde_json::Value::String(s) => {
            out.insert(prefix.to_string(), s.clone());
        }
        _ => {}
    }
}

/// Códigos de los idiomas disponibles.
pub fn supported() -> impl Iterator<Item = &'static str> {
    LOCALES.iter().map(|(code, _)| *code)
}

/// Convierte una etiqueta de idioma (`es`, `es-ES`, `es_ES.UTF-8`) en un idioma disponible.
pub fn normalize(tag: &str) -> Option<&'static str> {
    let lang = tag.split(['_', '-', '.', '@']).next()?.trim().to_ascii_lowercase();
    supported().find(|code| *code == lang)
}

/// Idioma del sistema según las variables de entorno de locale, o el de reserva.
pub fn system_language() -> &'static str {
    system_language_from(|name| std::env::var(name).ok())
}

fn system_language_from(var: impl Fn(&str) -> Option<String>) -> &'static str {
    // `LANGUAGE` es una lista por preferencia (`es:en`); las demás, un único locale.
    let mut tags: Vec<String> = var("LANGUAGE").map(|l| l.split(':').map(str::to_string).collect()).unwrap_or_default();
    tags.extend(["LC_ALL", "LC_MESSAGES", "LANG"].iter().filter_map(|n| var(n)));
    tags.iter().filter(|t| !t.is_empty()).find_map(|t| normalize(t)).unwrap_or(FALLBACK)
}

/// Idioma efectivo: la preferencia guardada si es válida; si no (o si es automática), el del sistema.
pub fn resolve(preference: Option<&str>) -> &'static str {
    preference.and_then(normalize).unwrap_or_else(system_language)
}

pub fn set_language(code: &str) {
    let code = normalize(code).unwrap_or(FALLBACK);
    *CURRENT.write().unwrap_or_else(|p| p.into_inner()) = code;
}

pub fn current() -> &'static str {
    *CURRENT.read().unwrap_or_else(|p| p.into_inner())
}

/// Traduce `key` al idioma `lang` sustituyendo los huecos `{nombre}`. Si falta la clave se usa
/// el idioma de reserva y, en último caso, la propia clave.
pub fn tr_in(lang: &str, key: &str, args: &[(&str, String)]) -> String {
    let template = [lang, FALLBACK]
        .iter()
        .find_map(|l| CATALOGS.get(l).and_then(|c| c.get(key)))
        .map(String::as_str)
        .unwrap_or(key);
    interpolate(template, args)
}

/// Traduce `key` al idioma actual. Normalmente se usa a través de [`t!`](crate::t).
pub fn tr(key: &str, args: &[(&str, String)]) -> String {
    tr_in(current(), key, args)
}

fn interpolate(template: &str, args: &[(&str, String)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find('}') {
            Some(close) => {
                let name = &after[..close];
                match args.iter().find(|(n, _)| *n == name) {
                    Some((_, value)) => out.push_str(value),
                    None => out.push_str(&rest[open..open + close + 2]),
                }
                rest = &after[close + 1..];
            }
            None => {
                out.push_str(&rest[open..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// Convierte cualquier `Display` en argumento de [`tr`].
pub fn arg(value: impl Display) -> String {
    value.to_string()
}

/// `t!("backend.clave")` o `t!("backend.clave", path = dir.display(), e = e)`: traduce al idioma
/// actual y devuelve un `String`.
#[macro_export]
macro_rules! t {
    ($key:expr) => {
        $crate::i18n::tr($key, &[])
    };
    ($key:expr, $($name:ident = $value:expr),+ $(,)?) => {
        $crate::i18n::tr($key, &[$((stringify!($name), $crate::i18n::arg(&$value))),+])
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    // Los tests usan `tr_in` y nunca cambian el idioma global: se ejecutan en paralelo.

    fn placeholders(s: &str) -> BTreeSet<String> {
        let mut out = BTreeSet::new();
        let mut rest = s;
        while let Some(open) = rest.find('{') {
            let after = &rest[open + 1..];
            let Some(close) = after.find('}') else { break };
            out.insert(after[..close].to_string());
            rest = &after[close + 1..];
        }
        out
    }

    #[test]
    fn all_locales_have_the_same_keys_and_placeholders() {
        let reference = &CATALOGS[FALLBACK];
        for (code, catalog) in CATALOGS.iter() {
            let missing: Vec<_> = reference.keys().filter(|k| !catalog.contains_key(*k)).collect();
            let extra: Vec<_> = catalog.keys().filter(|k| !reference.contains_key(*k)).collect();
            assert!(missing.is_empty() && extra.is_empty(), "{code}: faltan {missing:?}, sobran {extra:?}");
            for (key, text) in reference {
                assert_eq!(placeholders(text), placeholders(&catalog[key]), "{code}: huecos distintos en «{key}»");
            }
        }
    }

    #[test]
    fn translates_with_placeholders_and_fallbacks() {
        assert_eq!(interpolate("No existe {path}: {e}", &[("path", "/x".into()), ("e", "boom".into())]), "No existe /x: boom");
        assert_eq!(interpolate("deja {otro} y {sin cerrar", &[]), "deja {otro} y {sin cerrar");
        assert_eq!(tr_in("es", "no.existe", &[]), "no.existe");
        assert_eq!(tr_in("xx", "backend.noVault", &[]), tr_in("en", "backend.noVault", &[]));
        assert_ne!(tr_in("es", "backend.noVault", &[]), tr_in("en", "backend.noVault", &[]));
    }

    #[test]
    fn normalizes_locale_tags() {
        assert_eq!(normalize("es_ES.UTF-8"), Some("es"));
        assert_eq!(normalize("en-GB"), Some("en"));
        assert_eq!(normalize("ES"), Some("es"));
        assert_eq!(normalize("fr_FR.UTF-8"), None);
        assert_eq!(normalize("C"), None);
    }

    #[test]
    fn detects_system_language_in_priority_order() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |name: &str| pairs.iter().find(|(n, _)| *n == name).map(|(_, v)| v.to_string())
        };
        assert_eq!(system_language_from(env(&[("LANG", "es_ES.UTF-8")])), "es");
        assert_eq!(system_language_from(env(&[("LANGUAGE", "fr:es"), ("LANG", "en_US.UTF-8")])), "es");
        assert_eq!(system_language_from(env(&[("LC_ALL", "en_US.UTF-8"), ("LANG", "es_ES.UTF-8")])), "en");
        assert_eq!(system_language_from(env(&[("LANG", "de_DE.UTF-8")])), FALLBACK);
        assert_eq!(system_language_from(env(&[])), FALLBACK);
    }
}
