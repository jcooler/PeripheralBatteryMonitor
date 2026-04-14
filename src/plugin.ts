import streamDeck from "@elgato/streamdeck";
import { BatteryAction } from "./actions/battery-action";

// Production logging level
streamDeck.logger.setLevel("info");

// Register the battery monitor action
streamDeck.actions.registerAction(new BatteryAction());

// Connect to the Stream Deck
streamDeck.connect();
