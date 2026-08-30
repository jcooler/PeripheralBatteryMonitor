import streamDeck, { action } from "@elgato/streamdeck";
import { BatteryAction } from "./actions/battery-action";

@action({ UUID: "com.jcooler.peripheral-battery.monitor" })
class RegisteredBatteryAction extends BatteryAction {}

// Production logging level
streamDeck.logger.setLevel("info");

// Register the battery monitor action
streamDeck.actions.registerAction(new RegisteredBatteryAction());

// Connect to the Stream Deck
streamDeck.connect();
