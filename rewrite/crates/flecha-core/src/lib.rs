//! Durable browser state and policies shared by the engine and the UI.

mod settings;
pub mod shortcuts;
pub mod sleep;
mod state;
pub mod storage;
pub mod suggestions;

pub use settings::*;
pub use state::*;
