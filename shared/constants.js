(function (root) {
  const LOTS = ["Calvary Baptist","FUMC","First Pres","Burl Lot","Broadway","Jefferson","Tony's Storage"];
  const EMP_HOME_TAGS = ["Unassigned", ...LOTS];

  const DEFAULT_ROSTER = [
    "AJ Abram","Ransom Anotine","Luke Argamasilla","Blake Ball","Caden Barrett","Cameron Bays","Brody Beall",
    "Gavin Berger","Graham Botner","Charlie Bradley","Nathanael Byrne","Joshua Carr","Brock Carroll","Roger Carroll",
    "Benjamin Carter","Jordan Carter","William Carter","Luke Casper","Lucas Cobler","Alberto Cocke","Dalton Crouse",
    "Forde Cruse","Nicholas Degrandi","Alec De Renzo","Jaeger Ellerman","Jackson Elstner","Jack English","TJ Field",
    "Alex Fiore","Rafael Gebrezgi","James Giles","Shane Giles","Braxton Goldthorpe","Matthew Golinski","Mark Golminas",
    "Aaron Gorz","Tom Goshorn","Gabriel Gritton","Daniel Guandolo","Nathan Hale","Silas Hall","Josh Harney",
    "Braxton Hendrick","Jackson Hitt","Deeneo Hodzic","Jack Johnson","Andrew Joyner","Nicholas Kane","Karson Kayse",
    "Calvin Kent","Grant Kiser","Dylan Klatt","Grayson Klehr","Phillip Lehman","Ed Livers","Charlie Mackey",
    "Jeffrey Maddox","Benjamin Mahoney","Miles Malicki","Michaleen Marron","Isaac Mason","Gavin Mccord","Jack McCubbin",
    "Cheryl McDaniel","Andrew Michalak","John Monahan","Desa Montovani","John Moyano","Trey Mozzali","John Mulvey",
    "Rodrigo Negron","Cole Nelson","Benjamin Nikoleit","Jacob Noon","Morgan Oliver","Tyler Olson","Jake Parritt",
    "Krish Patel","Logan Pawley","Michael Proto","Samuel Pruden","Alex Rayyan","Chaz Rich","Nate Rich",
    "Landon Richard","Isaiah Robards","John Sanders","Gregory Sarceno","Tyler Schoen","Sam Scott","Daniel Shick",
    "Ty Shleton","Bennett Shrensker","Rocco Sinisgalli","Max Sivore","Gregory Skinner","Alex Sledd","Cole Space",
    "Charles Spiller","Nate Surrey","Charles Traughber","Caleb Triplett","William Turner","Jack Vernon","Anthony Villanova",
    "Charlie Wainscott","Parker Warren","Elijah Webb","Cole Wethington","Keundray Williams","Kevin Worthy"
  ];

  const STATE_ORDER = [null, "available", "unavailable"];
  const STATE_LABEL = { available: "Available", unavailable: "Unavailable" };

  // Fixed daily shift slots — these repeat every applicable day automatically.
  // days: 'all' or an array of JS getDay() values (0=Sun...6=Sat). Fri=5, Sat=6.
  const DAILY_TEMPLATES = {
    "Tony's": [
      { id: 'tonys-mgr',   label: 'Manager',         start: '16:15', end: '23:00', days: 'all' },
      { id: 'tonys-r430',  label: '4:30 Runner',     start: '16:30', end: '23:00', days: 'all' },
      { id: 'tonys-r430b', label: '4:30 Runner (2)', start: '16:30', end: '23:00', days: [5, 6] },
      { id: 'tonys-r500',  label: '5:00 Runner',     start: '17:00', end: '23:00', days: 'all' },
      { id: 'tonys-r530',  label: '5:30 Runner',     start: '17:30', end: '23:00', days: 'all' },
      { id: 'tonys-r600',  label: '6:00 Runner',     start: '18:00', end: '23:00', days: 'all' }
    ],
    "Dudley's": [
      { id: 'dudleys-r1',  label: 'Runner 1', start: '16:30', end: '23:00', days: 'all' },
      { id: 'dudleys-r2',  label: 'Runner 2', start: '16:30', end: '23:00', days: 'all' },
      { id: 'dudleys-mgr', label: 'Manager',  start: '17:30', end: '20:30', days: [5, 6] }
    ]
  };

  function slotApplies(slot, dateOrDay) {
    const day = dateOrDay instanceof Date ? dateOrDay.getDay() : dateOrDay;
    if (slot.days === 'all') return true;
    return slot.days.includes(day);
  }

  const constants = { LOTS, EMP_HOME_TAGS, DEFAULT_ROSTER, STATE_ORDER, STATE_LABEL, DAILY_TEMPLATES, slotApplies };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = constants;
  } else {
    root.APP_CONSTANTS = constants;
  }
})(typeof window !== 'undefined' ? window : globalThis);
