import { Component, OnInit } from '@angular/core';
import Siema from 'siema';

@Component({
  selector: 'app-skills',
  templateUrl: './skills.component.html',
  styleUrls: ['./skills.component.scss']
})
export class SkillsComponent implements OnInit {

  constructor() { }
  isMobile = false;
  getIsMobile(): boolean {
    const w = document.documentElement.clientWidth;
    const breakpoint = 992;
    console.log(w);
    if (w < breakpoint) {
      return true;
    } else {
      return false;
    }
  }

  ngOnInit(): void {
    this.isMobile = this.getIsMobile();
    window.onresize = () => {
      this.isMobile = this.getIsMobile();
      
    };
    const skills = new Siema({
      perPage: {
          768: 1,
          992: 3,
      },
      selector: '.skill',
      duration: 200,
      easing: 'ease-out',
      startIndex: 0,
      draggable: true,
      multipleDrag: true,
      threshold: 20,
      loop: true,
      rtl: false,
      onInit: () => {},
      onChange: () => {},
  });
  setInterval(() => skills.next(), 1500);
  }

}
