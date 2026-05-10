use napi::bindgen_prelude::Result;
use std::cell::RefCell;
use std::collections::HashMap;
use tree_sitter::{Language, Parser, Tree};

struct ParserPool {
    parsers: HashMap<String, Parser>,
}

impl ParserPool {
    fn new() -> Self {
        Self {
            parsers: HashMap::new(),
        }
    }

    fn get_or_create(&mut self, language_id: &str, language: &Language) -> Result<&mut Parser> {
        if self.parsers.contains_key(language_id) {
            return Ok(self.parsers.get_mut(language_id).unwrap());
        }
        let mut parser = Parser::new();
        parser
            .set_language(language)
            .map_err(|err| napi::Error::from_reason(format!("Failed to set parser language: {err}")))?;
        self.parsers.insert(language_id.to_string(), parser);
        Ok(self.parsers.get_mut(language_id).unwrap())
    }
}

thread_local! {
    static PARSER_POOL: RefCell<ParserPool> = RefCell::new(ParserPool::new());
}

pub(crate) fn parse_source(source: &str, language_id: &str, language: &Language) -> Result<Tree> {
    PARSER_POOL.with(|pool| {
        let mut pool = pool.borrow_mut();
        let parser = pool.get_or_create(language_id, language)?;
        parser
            .parse(source, None)
            .ok_or_else(|| napi::Error::from_reason("Failed to parse source".to_string()))
    })
}
