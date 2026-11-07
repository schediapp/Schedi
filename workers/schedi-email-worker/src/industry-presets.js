/** Industry values accepted by live email-worker v132 signup. */
export const INDUSTRY_PRESETS = [
  { value: "Services", label: "Services" },
  { value: "Barbershop", label: "Barbershop / Hair salon" },
  { value: "Nail salon", label: "Nail salon" },
  { value: "Lash / brow", label: "Lash / brow" },
  { value: "Spa / massage", label: "Spa / massage" },
  { value: "Esthetician", label: "Esthetician" },
  { value: "Tattoo / piercing", label: "Tattoo / piercing" },
  { value: "Makeup artist", label: "Makeup artist" },
  { value: "Personal trainer", label: "Personal trainer" },
  { value: "Yoga / pilates", label: "Yoga / pilates" },
  { value: "Fitness", label: "Fitness & Personal Training" },
  { value: "Pet grooming", label: "Pet grooming" },
  { value: "Dog training", label: "Dog training" },
  { value: "Auto", label: "Auto detailing" },
  { value: "Mobile car wash", label: "Mobile car wash" },
  { value: "House cleaning", label: "House cleaning" },
  { value: "Photography", label: "Photography" },
  { value: "Tutoring", label: "Tutoring" },
  { value: "Music lessons", label: "Music lessons" },
  { value: "Coaching", label: "Coaching" },
  { value: "Consulting", label: "Consulting / Executive" },
  { value: "Event / party rentals", label: "Event / party rentals" },
  { value: "Medical", label: "Medical / Healthcare" },
];

export const INDUSTRY_CHOICES = INDUSTRY_PRESETS.map((row) => row.value);
